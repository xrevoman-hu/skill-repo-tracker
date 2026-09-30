import type { UiRepository } from "./api";
import { Button, Modal, Tag } from "./UiPrimitives";
import { isRepositoryBackupEligible } from "./repositoryBackup";

type BackupModalProps = {
  targetRepos: UiRepository[];
  backupRoot: string;
  onClose: () => void;
  onConfirm: () => void | Promise<void>;
  mode: string;
  pending: boolean;
  language: string;
  t: (key: string) => string;
};

export function RepositoryBackupModal({
  targetRepos,
  backupRoot,
  onClose,
  onConfirm,
  mode,
  pending,
  language,
  t,
}: BackupModalProps) {
  const eligibleRepos = targetRepos.filter(isRepositoryBackupEligible);
  const backupableRepos = eligibleRepos.filter((repo) => repo.backupStatus !== "check-failed");
  const skippedRepos = eligibleRepos.filter((repo) => repo.backupStatus === "check-failed");
  const neverBackedCount = backupableRepos.filter((repo) => repo.backupStatus === "never-backed-up").length;
  const updatedCount = backupableRepos.filter((repo) => repo.backupStatus === "updated-not-backed-up").length;
  return (
    <Modal
      title={mode === "selected" ? t("backupSelectedTitle") : t("backupUpdatedTitle")}
      onClose={onClose}
      closeLabel={t("close")}
      footer={
        <>
          <Button onClick={onClose}>{t("cancel")}</Button>
          <Button
            variant="primary"
            onClick={onConfirm}
            disabled={!backupableRepos.length}
            pending={pending}
            pendingLabel={t("backingUp")}
          >
            {t("confirmBackup")}
          </Button>
        </>
      }
    >
      <div className="backup-summary">
        <div>
          <strong>{backupableRepos.length}</strong>
          <span>{t("willBeBackedUp")}</span>
        </div>
        <div>
          <strong>{neverBackedCount}</strong>
          <span>{t("neverBacked")}</span>
        </div>
        <div>
          <strong>{updatedCount}</strong>
          <span>{t("updated")}</span>
        </div>
        <div>
          <strong>{skippedRepos.length}</strong>
          <span>{t("checkFailedSkipped")}</span>
        </div>
      </div>
      <div className="result-box">
        <strong>{t("outputDirectory")}</strong>
        <p>{backupRoot}/2026-06-14_101212</p>
        <p>{t("outputDirectoryText")}</p>
      </div>
      <div className="result-box">
        <strong>{t("targetRepositories")}</strong>
        {eligibleRepos.length ? (
          <ul className="target-list">
            {eligibleRepos.slice(0, 8).map((repo) => (
              <li key={repo.id}>
                <span>{repo.name}</span>
                <Tag value={repo.backupStatus} language={language} />
              </li>
            ))}
            {eligibleRepos.length > 8 && <li>+ {eligibleRepos.length - 8}</li>}
          </ul>
        ) : (
          <p>{t("noFilteredRepositoriesText")}</p>
        )}
      </div>
    </Modal>
  );
}

type RepositorySelectionActionsProps = {
  selectedCount: number;
  backupCount?: number;
  otherPageCount: number;
  onBackup: () => void;
  onClear: () => void;
  t: (key: string) => string;
};

export function RepositorySelectionActions({
  selectedCount,
  backupCount = selectedCount,
  otherPageCount,
  onBackup,
  onClear,
  t,
}: RepositorySelectionActionsProps) {
  return (
    <>
      <Button disabled={backupCount === 0} onClick={onBackup}>
        {t("backupSelectedCount").replace("{count}", String(backupCount))}
      </Button>
      {selectedCount > 0 && (
        <span className="repository-selection-status">
          {selectedCount > backupCount && <span>{t("selectedBackupExcluded").replace("{count}", String(selectedCount - backupCount))}</span>}
          {otherPageCount > 0 && (
            <span>{t("selectedOnOtherPages").replace("{count}", String(otherPageCount))}</span>
          )}
          <button className="selection-clear-button" onClick={onClear} type="button">
            {t("clearSelection")}
          </button>
        </span>
      )}
    </>
  );
}
