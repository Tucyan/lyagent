import { useEffect, useState, type FormEvent } from "react";
import {
  buildModelSettingsPayload,
  modelSettingsRequest,
  modelSettingsStateFromStatus,
  waitForRestartHealth,
  type ModelSettingsFormState,
  type ModelSettingsStatus,
} from "./model-settings-page-model";

export function ModelSettingsPage({ mode }: { mode: "setup" | "settings" }) {
  const [form, setForm] = useState<ModelSettingsFormState>();
  const [csrfToken, setCsrfToken] = useState("");
  const [busy, setBusy] = useState<"test" | "save">();
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [converter, setConverter] = useState<{ provider: "docling"; status: string; device: "auto" | "cpu" }>();

  useEffect(() => {
    void fetch("/api/system/models", { cache: "no-store" }).then(async (response) => {
      if (!response.ok) throw new Error();
      setCsrfToken(response.headers.get("x-csrf-token") ?? "");
      setForm(modelSettingsStateFromStatus(await response.json() as ModelSettingsStatus));
    }).catch(() => setError("无法读取模型设置，请确认本地服务正在运行。"));
  }, []);
  useEffect(() => { void fetch("/api/system/runtime", { cache: "no-store" }).then((response) => response.ok ? response.json() : undefined).then((value: { converter?: { provider: "docling"; status: string; device: "auto" | "cpu" } } | undefined) => setConverter(value?.converter)).catch(() => undefined); }, []);

  const submit = async (action: "test" | "save") => {
    if (!form || !csrfToken) return;
    setBusy(action); setError(""); setNotice("");
    try {
      const payload = buildModelSettingsPayload(form);
      const response = await fetch(action === "test" ? "/api/system/models/test" : "/api/system/models", modelSettingsRequest(action === "test" ? "POST" : "PUT", csrfToken, payload));
      if (!response.ok) throw new Error();
      setNotice(action === "test" ? "连接测试成功。" : "设置已安全保存。");
      if (action === "save") {
        const saved = await response.json() as ModelSettingsStatus & { restartRequired?: boolean; restartScheduled?: boolean; instanceId?: string };
        setForm(modelSettingsStateFromStatus(saved));
        if (saved.restartScheduled) {
          setNotice("设置已安全保存，Course Agent 正在重启。");
          const ready = await waitForRestartHealth({
            health: async () => { const health = await fetch("/api/health", { cache: "no-store" }); const state = await health.json() as { ok?: boolean; instanceId?: string }; return health.ok && state.ok === true && Boolean(state.instanceId) && state.instanceId !== saved.instanceId; },
            sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
          });
          if (!ready) throw new Error("restart-timeout");
          window.location.assign(mode === "setup" ? "/" : "/settings/models");
        }
      }
    } catch (caught) {
      setError(caught instanceof Error && caught.message.includes("必填") ? caught.message : "模型连接或保存失败，请检查模型 ID、Base URL 和 API Key。当前表单与已保存设置均未被覆盖。");
    } finally { setBusy(undefined); }
  };

  if (!form) return <main className="model-settings-page"><section><h1>{mode === "setup" ? "首次设置" : "模型设置"}</h1><p>{error || "正在读取安全配置…"}</p></section></main>;
  const updatePrimary = (field: "modelId" | "baseUrl" | "apiKey", value: string) => setForm({ ...form, primary: { ...form.primary, [field]: value } });
  const handleSubmit = (event: FormEvent) => { event.preventDefault(); void submit("save"); };
  return <main className="model-settings-page">
    <header><div><p className="eyebrow">Course Agent</p><h1>{mode === "setup" ? "首次设置" : "模型设置"}</h1></div>{mode === "settings" && <a href="/">返回工作台</a>}</header>
    <section className="model-settings-card">
      {converter && <p className="model-routing-note">Docling 文档转换器：{converter.status} · {converter.device}</p>}
      <p className="model-routing-note">主模型不处理图片；批改工具成功读取图片后，本次运行会从下一轮起切换至视觉模型，并在该次运行余下轮次保持使用视觉模型。</p>
      <form onSubmit={handleSubmit}>
        <fieldset><legend>主模型（必填）</legend>
          <label>模型 ID<input required value={form.primary.modelId} onChange={(event) => updatePrimary("modelId", event.target.value)} /></label>
          <label>Base URL<input required type="url" value={form.primary.baseUrl} onChange={(event) => updatePrimary("baseUrl", event.target.value)} /></label>
          <label>API Key<input required={!form.primary.configured} type="password" autoComplete="new-password" value={form.primary.apiKey} placeholder={form.primary.configured ? "已安全保存；留空表示保持不变" : "请输入 API Key"} onChange={(event) => updatePrimary("apiKey", event.target.value)} /></label>
        </fieldset>
        <fieldset><legend>视觉模型（可选）</legend>
          <label className="model-inline"><input type="checkbox" checked={form.visionEnabled} onChange={(event) => setForm({ ...form, visionEnabled: event.target.checked })} />启用视觉模型</label>
          {form.visionEnabled && <>
            <label>视觉模型 ID<input required value={form.visionModelId} onChange={(event) => setForm({ ...form, visionModelId: event.target.value })} /></label>
            <label className="model-inline"><input type="checkbox" checked={form.visionUsesPrimaryCredentials} onChange={(event) => setForm({ ...form, visionUsesPrimaryCredentials: event.target.checked })} />复用主模型的 Base URL 与 API Key</label>
            {!form.visionUsesPrimaryCredentials && <>
              <label>视觉 Base URL<input required type="url" value={form.visionBaseUrl} onChange={(event) => setForm({ ...form, visionBaseUrl: event.target.value })} /></label>
              <label>视觉 API Key<input required={!form.visionConfigured} type="password" autoComplete="new-password" value={form.visionApiKey} placeholder={form.visionConfigured ? "已安全保存；留空表示保持不变" : "请输入视觉 API Key"} onChange={(event) => setForm({ ...form, visionApiKey: event.target.value })} /></label>
            </>}
          </>}
        </fieldset>
        {error && <p className="model-error" role="alert">{error}</p>}
        {notice && <p className="model-success" role="status">{notice}</p>}
        <div className="model-actions"><button type="button" disabled={Boolean(busy)} onClick={() => void submit("test")}>{busy === "test" ? "测试中…" : "测试连接"}</button><button type="submit" disabled={Boolean(busy)}>{busy === "save" ? "保存中…" : "保存设置"}</button></div>
      </form>
    </section>
    <aside className="model-about" aria-label="关于与第三方组件"><strong>关于与第三方组件</strong><p>文档解析能力由 Docling 提供；完整第三方许可证随发布包提供。</p></aside>
  </main>;
}
