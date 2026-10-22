import { useEffect, useRef, useState } from "react";
import { Button, Modal } from "./UiPrimitives";
import { credentialError } from "./credentialTypes";
import type { CredentialAgentClient, CredentialResults, CredentialTransport } from "./credentialTypes";

const CLIENTS: [CredentialAgentClient, string][] = [["codex", "Codex"], ["claude_code", "Claude Code"], ["workbuddy", "WorkBuddy"], ["deepseek_harness", "DeepSeek Harness"], ["generic", "通用 MCP / Generic MCP"]];

export function CredentialAgentGuide({ transport, language, copyText, onClose }: {
  transport: CredentialTransport; language: string; copyText: (text: string) => Promise<void>; onClose: () => void;
}) {
  const zh = language === "zh";
  const [client, setClient] = useState<CredentialAgentClient>("codex");
  const [guide, setGuide] = useState<CredentialResults["agent_guide"] | null>(null);
  const [loading, setLoading] = useState(true);
  const [copying, setCopying] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const generation = useRef(0);
  useEffect(() => {
    const token = ++generation.current;
    setGuide(null); setLoading(true); setError(""); setMessage("");
    void transport.request({ action: "agent_guide", client }).then((result) => {
      if (token === generation.current && result.client === client) setGuide(result);
    }).catch((failure: unknown) => { if (token === generation.current) setError(credentialError(failure, language)); })
      .finally(() => { if (token === generation.current) setLoading(false); });
    return () => { generation.current += 1; };
  }, [transport, client, language]);
  async function copy() {
    if (!guide?.ready || loading || copying) return;
    const token = generation.current;
    setCopying(true); setError(""); setMessage("");
    try {
      // Recheck readiness immediately before copying; no authorization is changed here.
      const current = await transport.request({ action: "agent_guide", client });
      if (token !== generation.current || current.client !== client) return;
      setGuide(current);
      if (!current.ready) return;
      await copyText(current.text);
      if (token === generation.current) setMessage(zh ? "已复制所选 Agent 的说明。配置与实际连接仍需在客户端完成。" : "The selected guide was copied. Configuration and connection still need to be completed in the client.");
    } catch { if (token === generation.current) setError(zh ? "未能复制接入说明，请重试。" : "Could not copy the connection guide. Retry."); }
    finally { setCopying(false); }
  }
  return <Modal title={zh ? "Agent 接入说明" : "Agent connection guide"} closeLabel={zh ? "关闭" : "Close"} onClose={onClose}
    footer={<><Button onClick={onClose}>{zh ? "关闭" : "Close"}</Button><Button disabled={loading || !guide?.ready} pending={copying} onClick={() => void copy()}>{zh ? "复制说明给 Agent" : "Copy guide for Agent"}</Button></>}>
    <label className="credential-field"><span>Agent</span><select disabled={copying} value={client} onChange={(event) => setClient(event.target.value as CredentialAgentClient)}>{CLIENTS.map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
    {loading ? <p role="status">{zh ? "正在生成说明…" : "Generating guide…"}</p> : guide && <>
      {!guide.ready && <p className="credential-error" role="status">{guide.reason ? credentialError({ code: guide.reason }, language) : (zh ? "接入尚未就绪，暂不能复制配置。" : "The connection is not ready; configuration cannot be copied yet.")}</p>}
      <pre className="credential-guide-text">{guide.text}</pre></>}
    <p className="credential-hint">{zh ? "只复制所选客户端的说明，不自动修改配置。主密码和访问码不进入文档；复制不代表已连接。" : "Only the selected guide is copied; client configuration is not changed automatically. Passwords and access codes are excluded. Copying does not mean connected."}</p>
    {message && <p role="status">{message}</p>}{error && <p className="credential-error" role="alert">{error}</p>}
  </Modal>;
}
