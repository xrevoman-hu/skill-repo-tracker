use super::{
    flow_tests::{connect, detail, export, ok, peer, prepare, request, run, TestWindow},
    tests::cleanup_client,
    *,
};

#[test]
fn prepare_export_binds_only_known_file_metadata_and_cancel_returns_no_ticket() {
    for (metadata, expected) in [
        (json!({"version":1}), "record_version_conflict"),
        (json!({"version":2,"files":[]}), "field_not_found"),
    ] {
        let (_dir, client, _clipboard, _destination) = cleanup_client();
        connect(
            &client,
            vec![(
                json!({"action":"detail","recordId":"synthetic-record"}),
                ok(metadata),
            )],
        );
        assert_eq!(
            run(&client, prepare(), &TestWindow::default()),
            Err(expected)
        );
        assert!(client.selections.lock().unwrap().export.is_none());
    }
    let (_dir, client, _clipboard, _destination) = cleanup_client();
    connect(
        &client,
        vec![(
            json!({"action":"detail","recordId":"synthetic-record"}),
            ok(detail()),
        )],
    );
    assert_eq!(
        run(&client, prepare(), &TestWindow::default()).unwrap(),
        json!({"selectionId":null})
    );
}

#[test]
fn successful_export_returns_no_bytes_and_failed_focus_removes_staging_without_publishing() {
    for focus in [true, false] {
        let (_dir, client, _clipboard, destination) = cleanup_client();
        let path = destination.join("chosen-file");
        connect(
            &client,
            vec![(
                json!({"action":"detail","recordId":"synthetic-record"}),
                ok(detail()),
            )],
        );
        let chosen = run(
            &client,
            prepare(),
            &TestWindow {
                selection: Ok(Some(path.clone())),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(chosen["name"], "chosen-file");
        assert!(chosen.get("path").is_none());
        let input = export(chosen["selectionId"].as_str().unwrap());
        let bytes = b"synthetic\0original\r\nbytes\xff";
        connect(
            &client,
            vec![(
                input.clone(),
                ok(json!({"bytesBase64":base64::engine::general_purpose::STANDARD.encode(bytes)})),
            )],
        );
        let result = run(
            &client,
            input,
            &TestWindow {
                focus: Ok(focus),
                ..Default::default()
            },
        );
        if focus {
            assert_eq!(result.unwrap(), json!({"exported":true}));
            assert_eq!(std::fs::read(&path).unwrap(), bytes);
        } else {
            assert_eq!(result, Err("human_session_invalid"));
            assert!(!path.exists());
            assert_eq!(std::fs::read_dir(&destination).unwrap().count(), 0);
        }
        assert!(!client.root.join("export-pending.json").exists());
        assert!(client.selections.lock().unwrap().export.is_none());
    }
}

#[test]
fn export_tickets_are_single_use_bound_and_private_transport_must_contain_valid_bytes() {
    for (ticket_mode, payload, expected) in [
        (
            "missing",
            json!({"bytesBase64":"YQ=="}),
            "file_selection_required",
        ),
        (
            "wrong",
            json!({"bytesBase64":"YQ=="}),
            "file_selection_required",
        ),
        (
            "binding",
            json!({"bytesBase64":"YQ=="}),
            "file_selection_required",
        ),
        ("valid", json!({}), "file_export_failed"),
        ("valid", json!({"bytesBase64":"??"}), "file_export_failed"),
        ("valid", json!({"bytesBase64":""}), "file_limit_exceeded"),
    ] {
        let (_dir, client, _clipboard, destination) = cleanup_client();
        let path = destination.join("must-not-exist");
        let selection = crate::credential_file_io::Selection::capture(
            path.clone(),
            request(prepare()).export_binding().unwrap(),
            &client.root,
            false,
        )
        .unwrap();
        let mut input = export(&selection.id);
        if ticket_mode == "wrong" {
            input["selectionId"] = json!("unknown");
        }
        if ticket_mode == "binding" {
            input["expectedVersion"] = json!(3);
        }
        if ticket_mode != "missing" {
            client.selections.lock().unwrap().export = Some(selection);
        }
        connect(&client, vec![(input.clone(), ok(payload))]);
        assert_eq!(run(&client, input, &TestWindow::default()), Err(expected));
        assert!(!path.exists());
        assert!(!client.root.join("export-pending.json").exists());
    }
}

#[test]
fn explicit_cancellation_during_picker_revokes_tickets_while_blur_allows_ciphertext_backup() {
    let (_dir, client, _clipboard, destination) = cleanup_client();
    let path = destination.join("cancelled-export");
    connect(
        &client,
        vec![(
            json!({"action":"detail","recordId":"synthetic-record"}),
            ok(detail()),
        )],
    );
    let cancel = || {
        client.invalidate_for(Action::Lock).unwrap();
    };
    assert_eq!(
        run(
            &client,
            prepare(),
            &TestWindow {
                selection: Ok(Some(path)),
                on_select: Some(&cancel),
                ..Default::default()
            }
        ),
        Err("stale_generation")
    );
    assert!(client.selections.lock().unwrap().export.is_none());
    let path = destination.join("ciphertext.srtvault");
    let backup = json!({"action":"backup_create","path":path});
    connect(
        &client,
        vec![(
            backup,
            ok(json!({"created":true,"warning":"backup_sync_unconfirmed"})),
        )],
    );
    let blur = || client.invalidate_focus();
    let result = run(
        &client,
        json!({"action":"backup_create"}),
        &TestWindow {
            selection: Ok(Some(path)),
            on_select: Some(&blur),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(
        result,
        json!({"created":true,"warning":"backup_sync_unconfirmed"})
    );
    assert!(client.delivery.lock().unwrap().session.is_none());
}

#[test]
fn backup_cancel_and_explicit_lock_do_not_reach_the_host_backup_operation() {
    for cancel in [false, true] {
        let (_dir, client, _clipboard, destination) = cleanup_client();
        connect(&client, vec![]);
        let lock = || {
            client.invalidate_for(Action::Lock).unwrap();
        };
        let window = TestWindow {
            selection: Ok(cancel.then(|| destination.join("cancelled.srtvault"))),
            on_select: cancel.then_some(&lock as &dyn Fn()),
            ..Default::default()
        };
        let result = run(&client, json!({"action":"backup_create"}), &window);
        if cancel {
            assert_eq!(result, Err("stale_generation"));
        } else {
            assert_eq!(result.unwrap(), json!({"created":false,"cancelled":true}));
        }
        assert_eq!(std::fs::read_dir(destination).unwrap().count(), 0);
    }
}

#[test]
fn restore_selection_locks_first_and_only_native_ticket_can_supply_the_backup_path() {
    let (_dir, client, _clipboard, destination) = cleanup_client();
    let path = destination.join("synthetic-backup.srtvault");
    std::fs::write(&path, b"synthetic selected ciphertext").unwrap();
    connect(
        &client,
        vec![
            (json!({"action":"lock"}), ok(json!({"locked":true}))),
            (
                json!({"action":"restore_cancel"}),
                ok(json!({"locked":true})),
            ),
        ],
    );
    let selected = run(
        &client,
        json!({"action":"restore_pick"}),
        &TestWindow {
            selection: Ok(Some(path.clone())),
            ..Default::default()
        },
    )
    .unwrap();
    assert!(selected.get("path").is_none());
    assert!(client.delivery.lock().unwrap().session.is_none());
    let input = json!({"action":"restore_preview","selectionId":selected["selectionId"],"password":"synthetic-backup-password"});
    let mut control = input.clone();
    control["path"] = json!(path);
    connect(
        &client,
        vec![(control, ok(json!({"recordCount":8,"sameVault":true})))],
    );
    assert_eq!(
        run(&client, input, &TestWindow::default()).unwrap()["recordCount"],
        8
    );
    connect(
        &client,
        vec![(
            json!({"action":"restore_cancel"}),
            ok(json!({"locked":true})),
        )],
    );
    assert_eq!(
        run(
            &client,
            json!({"action":"restore_cancel"}),
            &TestWindow::default()
        )
        .unwrap()["locked"],
        true
    );
    assert!(client.selections.lock().unwrap().restore.is_none());
}

#[test]
fn restore_cancel_invalid_ticket_changed_file_and_picker_error_do_not_load_a_backup() {
    let (_dir, client, _clipboard, destination) = cleanup_client();
    connect(
        &client,
        vec![
            (json!({"action":"lock"}), ok(json!({"locked":true}))),
            (
                json!({"action":"restore_cancel"}),
                ok(json!({"locked":true})),
            ),
        ],
    );
    assert_eq!(
        run(
            &client,
            json!({"action":"restore_pick"}),
            &TestWindow::default()
        )
        .unwrap(),
        json!({"selectionId":null})
    );
    for value in [
        json!({"action":"restore_preview"}),
        json!({"action":"restore_preview","selectionId":"unknown"}),
    ] {
        assert_eq!(
            run(&client, value, &TestWindow::default()),
            Err("file_selection_required")
        );
    }
    let path = destination.join("changed.srtvault");
    std::fs::write(&path, b"before").unwrap();
    let selected = crate::credential_file_io::Selection::capture(
        path.clone(),
        "restore".into(),
        &client.root,
        true,
    )
    .unwrap();
    let input = json!({"action":"restore_preview","selectionId":selected.id});
    client.selections.lock().unwrap().restore = Some(selected);
    std::fs::write(path, b"changed-by-another-process").unwrap();
    assert_eq!(
        run(&client, input, &TestWindow::default()),
        Err("selected_file_changed")
    );
    assert_eq!(
        run(
            &client,
            json!({"action":"backup_create"}),
            &TestWindow {
                selection: Err("selected_file_invalid"),
                ..Default::default()
            }
        ),
        Err("selected_file_invalid")
    );
}

#[test]
fn restored_commit_is_reported_as_committed_even_if_locked_host_restart_fails() {
    for (restart, durability_warning) in
        [(true, true), (false, true), (true, false), (false, false)]
    {
        let (_dir, client, _clipboard, _destination) = cleanup_client();
        let input = json!({"action":"restore_commit","confirm":true});
        connect(
            &client,
            vec![(
                input.clone(),
                ok(
                    json!({"restartRequired":true,"locked":true,"sharing":false,"durabilityWarning":durability_warning}),
                ),
            )],
        );
        let request = request(input);
        let stamp = client.invalidate_for(request.action).unwrap();
        let result = client
            .perform(request, &TestWindow::default(), stamp, |_| {
                if restart {
                    Ok(peer(vec![(
                        json!({"action":"status"}),
                        ok(json!({"locked":true,"sharing":false,"vaultId":"new-identity"})),
                    )]))
                } else {
                    Err("credential_host_unavailable")
                }
            })
            .unwrap();
        assert_eq!(result["locked"], true);
        assert_eq!(result["sharing"], false);
        assert_eq!(
            result["durabilityWarning"].as_bool().unwrap_or(false),
            durability_warning
        );
        if restart {
            assert_eq!(result["vaultId"], "new-identity");
            assert!(result.get("bridgeCommand").is_some());
        } else {
            assert_eq!(result["restartRequired"], true);
            assert!(client.connection.lock().unwrap().is_none());
        }
    }
}

#[test]
fn bad_export_journal_locks_host_and_status_keeps_cleanup_visible_until_retry() {
    use std::os::unix::fs::PermissionsExt;
    for action in ["status", "retry_cleanup", "list"] {
        let (_dir, client, clipboard, destination) = cleanup_client();
        let pending =
            crate::credential_export_journal::PendingExport::create(&client.root, &destination)
                .unwrap();
        let path = client.root.join("export-pending.json");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        connect(
            &client,
            vec![(
                json!({"action":"lock"}),
                ok(json!({"locked":true,"cleanupRemaining":2})),
            )],
        );
        let result = run(&client, json!({"action":action}), &TestWindow::default());
        if action == "list" {
            assert_eq!(result, Err("export_cleanup_failed"));
        } else {
            let result = result.unwrap();
            assert_eq!(result["locked"], true);
            assert_eq!(result["cleanupFailed"], true);
            assert_eq!(result["cleanupRemaining"], 3);
        }
        assert!(!clipboard.status().owned);
        assert!(path.exists());
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        drop(pending);
        assert!(!path.exists());
    }
}
