import { useEffect, useId, useRef } from "react";
import type { ReactNode } from "react";
import type { ButtonProps } from "./buttonProps";

const STATUS_LABELS = {
  zh: {
    "updated-not-backed-up": "需备份",
    "backed-up-latest": "已备份",
    "never-backed-up": "未备份",
    "backup-excluded": "无需备份",
    "local-only": "本地",
    "check-failed": "检测失败",
    "local-modified": "本地修改",
    "update-conflict": "待处理冲突",
    "source-unavailable": "来源不可用",
    "update-available": "可更新",
    "installed-latest": "最新",
    "installed-customized": "已更新，含本地定制",
    "not-installed": "未安装",
    deleted: "已删除",
    "partial-success": "部分成功",
    success: "成功",
    failed: "失败",
    interrupted: "已中断",
    "waiting-user": "等待用户处理",
    unknown: "未知",
    "skill repo": "技能仓库",
    "generic repo": "普通仓库",
    detected: "已识别",
    "codex-marketplace": "Codex 插件市场",
    "skills-cli": "Skills CLI",
    "clawhub-skill": "ClawHub 单技能",
    "structured-plugin": "结构化插件",
    local: "本地",
  },
  en: {
    "updated-not-backed-up": "needs backup",
    "backed-up-latest": "backed latest",
    "never-backed-up": "never backed",
    "backup-excluded": "no backup needed",
    "local-only": "local",
    "check-failed": "check failed",
    "local-modified": "local modified",
    "update-conflict": "update conflict",
    "source-unavailable": "source unavailable",
    "update-available": "update available",
    "installed-latest": "latest",
    "installed-customized": "updated with local customizations",
    "not-installed": "not installed",
    deleted: "deleted",
    "partial-success": "partial success",
    success: "success",
    failed: "failed",
    interrupted: "interrupted",
    "waiting-user": "waiting for user",
    unknown: "unknown",
    "skill repo": "skill repo",
    "generic repo": "generic repo",
    detected: "detected",
    "codex-marketplace": "Codex marketplace",
    "skills-cli": "Skills CLI",
    "clawhub-skill": "ClawHub single Skill",
    "structured-plugin": "structured plugin",
    local: "local",
  },
};

export function statusLabel(value: string, language = "zh") {
  const labels = STATUS_LABELS[language === "zh" ? "zh" : "en"] as Record<string, string>;
  return labels[value] || value.replaceAll("-", " ");
}

export function Button({
  children,
  variant = "secondary",
  onClick,
  disabled = false,
  className = "",
  pending = false,
  pendingLabel,
  type = "button",
  "aria-label": ariaLabel,
  "data-autofocus": dataAutofocus,
}: ButtonProps) {
  return (
    <button
      aria-label={ariaLabel}
      data-autofocus={dataAutofocus}
      className={`button ${variant} ${className} ${pending ? "is-pending" : ""}`}
      onClick={onClick}
      disabled={disabled || pending}
      type={type}
    >
      {pending ? pendingLabel || children : children}
    </button>
  );
}

export function Tag({ value, tone, language = "zh" }: {
  value: string;
  tone?: string;
  language?: string;
}) {
  return <span className={`tag ${tone || value}`}>{statusLabel(value, language)}</span>;
}

type ModalProps = {
  title: string;
  children: ReactNode;
  footer: ReactNode;
  onClose: () => void;
  closeLabel?: string;
};

export function Modal({ title, children, footer, onClose, closeLabel = "Close" }: ModalProps) {
  const titleId = useId();
  const bodyId = useId();
  const modalRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const modalElement = modalRef.current;
    const focusableSelector =
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';
    const initialFocus = modalElement?.querySelector<HTMLElement>("[data-autofocus]")
      || modalElement?.querySelector<HTMLElement>("[autofocus]")
      || modalElement?.querySelector<HTMLElement>(focusableSelector);
    initialFocus?.focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !modalElement) return;
      const focusable = Array.from(
        modalElement.querySelectorAll<HTMLElement>(focusableSelector),
      ) as HTMLElement[];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        aria-describedby={bodyId}
        aria-labelledby={titleId}
        className="modal"
        role="dialog"
        aria-modal="true"
        onMouseDown={(event) => event.stopPropagation()}
        ref={modalRef}
      >
        <header className="modal-header">
          <h2 id={titleId}>{title}</h2>
          <button aria-label={closeLabel} className="icon-button" onClick={onClose} type="button">
            {closeLabel}
          </button>
        </header>
        <div className="modal-body" id={bodyId}>{children}</div>
        <footer className="modal-footer">{footer}</footer>
      </section>
    </div>
  );
}
