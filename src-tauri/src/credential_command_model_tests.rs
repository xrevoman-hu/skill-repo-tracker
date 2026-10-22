use super::*;

fn request(value: Value) -> CredentialRequest {
    serde_json::from_value(value).unwrap()
}

#[test]
fn gui_paths_are_rejected_even_when_null_and_copy_is_scoped_to_exactly_one_field() {
    for path in [Value::Null, json!("/synthetic/untrusted"), json!(3)] {
        assert_eq!(
            request(json!({"action":"status","path":path})).validate_gui(),
            Err("invalid_arguments")
        );
    }
    let input = request(
        json!({"action":"copy_secret","recordId":"record","expectedVersion":2,"sessionId":"session","field":"password","fields":["unrequested"]}),
    );
    input.validate_gui().unwrap();
    let control = input.control_request().unwrap();
    assert_eq!(
        control,
        json!({"action":"read_fields","recordId":"record","expectedVersion":2,"sessionId":"session","fields":["password"]})
    );
    for field in [Value::Null, json!(42)] {
        assert_eq!(
            request(json!({"action":"copy_secret","field":field})).control_request(),
            Err("invalid_secret_field")
        );
    }
    let plain = json!({"action":"list","query":"synthetic"});
    assert_eq!(request(plain.clone()).control_request().unwrap(), plain);
}

#[test]
fn export_ticket_binding_requires_record_revision_and_field_without_ambiguous_concatenation() {
    let input = json!({"action":"prepare_export","recordId":"a|2","expectedVersion":3,"field":"privateKey"});
    assert_eq!(
        request(input.clone()).export_binding().unwrap(),
        json!(["a|2", 3, "privateKey"]).to_string()
    );
    for (field, error) in [
        ("recordId", "record_id_required"),
        ("expectedVersion", "record_version_conflict"),
        ("field", "field_not_found"),
    ] {
        let mut missing = input.clone();
        missing.as_object_mut().unwrap().remove(field);
        assert_eq!(request(missing).export_binding(), Err(error));
        let mut mistyped = input.clone();
        mistyped[field] = json!([]);
        assert_eq!(request(mistyped).export_binding(), Err(error));
    }
    let changed = json!({"action":"prepare_export","recordId":"a","expectedVersion":2,"field":"3|privateKey"});
    assert_ne!(
        request(input).export_binding().unwrap(),
        request(changed).export_binding().unwrap()
    );
}

#[test]
fn only_completed_state_changes_can_survive_a_later_delivery_generation() {
    let committed = [
        "lock",
        "invalidate_session",
        "backup_create",
        "change_password",
        "restore_commit",
        "restore_cancel",
        "save",
        "delete",
        "share",
        "reset_access",
        "authorize_access",
        "retry_cleanup",
    ];
    let requires_current = [
        "status",
        "create",
        "unlock",
        "list",
        "detail",
        "verify",
        "read_fields",
        "copy_secret",
        "prepare_export",
        "export_file",
        "restore_pick",
        "restore_preview",
        "agent_guide",
        "inspect_files",
    ];
    for (actions, expected) in [(&committed[..], true), (&requires_current[..], false)] {
        for action in actions {
            let request = request(json!({"action":action}));
            assert_eq!(request.action.completed_mutation(), expected, "{action}");
            assert_eq!(
                request
                    .control_request()
                    .map(|value| value["action"].clone()),
                if *action == "copy_secret" {
                    Err("invalid_secret_field")
                } else {
                    Ok(json!(action))
                }
            );
        }
    }
    assert!(serde_json::from_value::<CredentialRequest>(json!({"action":"shell"})).is_err());
}
