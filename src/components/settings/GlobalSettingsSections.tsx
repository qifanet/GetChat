/**
 * @file GlobalSettingsSections.tsx
 * @description Global settings sections shared across the application.
 *
 * Contains ToolSettingsSection, SecurityPolicySection, BuiltinToolsSection,
 * McpServersSection, and SkillsSection. These are global settings (use global
 * Tauri commands, not per-provider) and are displayed in AppSettingsView.
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import * as tauriCmd from "../../services/tauriCommands";
import { useSettingsToast } from "./AppSettingsView";

export const BUILTIN_TOOL_I18N_KEYS: Record<string, { nameKey: string; descriptionKey: string }> = {
  calculator: {
    nameKey: "settings.builtinToolCalculatorName",
    descriptionKey: "settings.builtinToolCalculatorDescription",
  },
  file: {
    nameKey: "settings.builtinToolFileName",
    descriptionKey: "settings.builtinToolFileDescription",
  },
  todo: {
    nameKey: "settings.builtinTodoName",
    descriptionKey: "settings.builtinTodoDescription",
  },
  terminal: {
    nameKey: "settings.builtinToolTerminalName",
    descriptionKey: "settings.builtinToolTerminalDescription",
  },
  web_search: {
    nameKey: "settings.builtinToolWebSearchName",
    descriptionKey: "settings.builtinToolWebSearchDescription",
  },
};

/** Tool calling settings (max iterations, failures, timeout). */
function ToolSettingsSection() {
  const { t } = useTranslation();
  const showToast = useSettingsToast();
  const [settings, setSettings] = useState<tauriCmd.ToolSettingsDto | null>(null);
  const [draft, setDraft] = useState<tauriCmd.ToolSettingsDto | null>(null);
  const [saving, setSaving] = useState(false);

  const FIELDS: { key: keyof tauriCmd.ToolSettingsDto; min: number; max: number; labelKey: string; helpKey: string }[] = [
    { key: "max_iterations", min: 1, max: 100, labelKey: "settings.maxIterations", helpKey: "settings.maxIterationsHelp" },
    { key: "max_consecutive_failures", min: 1, max: 20, labelKey: "settings.maxConsecutiveFailures", helpKey: "settings.maxConsecutiveFailuresHelp" },
    { key: "approval_timeout_secs", min: 10, max: 600, labelKey: "settings.approvalTimeout", helpKey: "settings.approvalTimeoutHelp" },
    { key: "tool_execution_timeout_secs", min: 10, max: 600, labelKey: "settings.toolExecutionTimeout", helpKey: "settings.toolExecutionTimeoutHelp" },
  ];

  useEffect(() => {
    tauriCmd.getToolSettings().then((loaded) => {
      setSettings(loaded);
      setDraft(loaded);
    }).catch(() => {});
  }, []);

  if (!settings || !draft) return null;

  async function handleSave() {
    if (!draft) return;
    const clamped = { ...draft };
    const corrections: string[] = [];
    for (const f of FIELDS) {
      const v = clamped[f.key] as number;
      if (v < f.min) { corrections.push(`${t(f.labelKey)}: ${v} → ${f.min}`); (clamped as any)[f.key] = f.min; }
      if (v > f.max) { corrections.push(`${t(f.labelKey)}: ${v} → ${f.max}`); (clamped as any)[f.key] = f.max; }
    }
    setSaving(true);
    try {
      const updated = await tauriCmd.updateToolSettings({
        max_iterations: clamped.max_iterations,
        max_consecutive_failures: clamped.max_consecutive_failures,
        approval_timeout_secs: clamped.approval_timeout_secs,
        tool_execution_timeout_secs: clamped.tool_execution_timeout_secs,
      });
      setSettings(updated);
      setDraft(updated);
      if (corrections.length > 0) {
        showToast(t("settings.valueAutoCorrected", { details: corrections.join("; ") }), "error");
      } else {
        showToast(t("common.saved"));
      }
    } catch (err) {
      console.error("[tool-settings] failed to save", err);
      showToast(t("settings.providerSaveFailed"), "error");
    } finally {
      setSaving(false);
    }
  }

  function updateField<K extends keyof tauriCmd.ToolSettingsDto>(key: K, value: string) {
    setDraft((prev) => prev ? { ...prev, [key]: value === "" ? "" : (parseInt(value, 10) || 0) } : prev);
  }

  return (
    <section id="section-tool-settings" className="app-panel min-w-0 rounded-shell bg-miro-card/95 p-5">
      <div className="flex min-w-0 flex-col gap-4">
        <div className="min-w-0">
          <h3 className="font-display text-base font-semibold tracking-[-0.02em] text-miro-text">
            {t("settings.toolSettingsTitle")}
          </h3>
          <p className="mt-1 text-xs text-miro-text-secondary">
            {t("settings.toolSettingsHelp")}
          </p>
        </div>
        <div className="flex min-w-0 items-end gap-3">
          <div className="min-w-0 flex-1 space-y-4">
            {FIELDS.map((f) => (
              <div key={f.key}>
                <label className="mb-1 block text-sm font-medium text-miro-text">
                  {t(f.labelKey)}
                </label>
                <div className="flex min-w-0 flex-wrap items-center gap-3">
                  <input
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]*"
                    value={draft[f.key] ?? ""}
                    className="w-24 rounded-md border border-miro-border/30 bg-miro-card px-3 py-1.5 text-sm text-miro-text focus:border-miro-blue focus:outline-hidden"
                    onChange={(e) => updateField(f.key, e.target.value.replace(/[^0-9]/g, ""))}
                  />
                  <span className="min-w-0 flex-1 text-xs text-miro-text-secondary">
                    {t(f.helpKey)}
                  </span>
                </div>
              </div>
            ))}
          </div>
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving}
            className="app-primary-button shrink-0 whitespace-nowrap"
          >
            {t("common.save")}
          </button>
        </div>
      </div>
    </section>
  );
}

/** Security policy level selection. */
function SecurityPolicySection() {
  const { t } = useTranslation();
  const showToast = useSettingsToast();
  const [policy, setPolicy] = useState<tauriCmd.SecurityPolicyDto | null>(null);

  useEffect(() => {
    tauriCmd.getSecurityPolicy().then(setPolicy).catch(() => {});
  }, []);

  if (!policy) return null;

  const levels: { value: tauriCmd.SecurityPolicyDto["level"]; labelKey: string; descKey: string }[] = [
    { value: "permissive", labelKey: "settings.securityPermissive", descKey: "settings.securityPermissiveDesc" },
    { value: "standard", labelKey: "settings.securityStandard", descKey: "settings.securityStandardDesc" },
    { value: "strict", labelKey: "settings.securityStrict", descKey: "settings.securityStrictDesc" },
  ];

  return (
    <section id="section-security-policy" className="app-panel min-w-0 rounded-shell bg-miro-card/95 p-5">
      <h3 className="font-display text-base font-semibold tracking-[-0.02em] text-miro-text">
        {t("settings.securityPolicyTitle")}
      </h3>
      <p className="mt-1 text-xs text-miro-text-secondary">
        {t("settings.securityPolicyHelp")}
      </p>
      <div className="mt-4 space-y-3">
        {levels.map((lv) => (
          <label
            key={lv.value}
            className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors ${
              policy.level === lv.value
                ? "border-miro-blue bg-miro-blue-light"
                : "border-miro-border/20 hover:border-miro-border/40"
            }`}
          >
            <input
              type="radio"
              name="securityLevel"
              value={lv.value}
              checked={policy.level === lv.value}
              className="mt-0.5"
              onChange={async () => {
                try {
                  const updated = await tauriCmd.updateSecurityPolicy({ level: lv.value });
                  setPolicy(updated);
                  showToast(t("common.saved"));
                } catch (err) {
                  console.error("[security-policy] failed to update", err);
                  showToast(t("settings.providerSaveFailed"), "error");
                }
              }}
            />
            <div className="min-w-0">
              <div className="text-sm font-medium text-miro-text">
                {t(lv.labelKey)}
              </div>
              <div className="text-xs text-miro-text-secondary">
                {t(lv.descKey)}
              </div>
            </div>
          </label>
        ))}
      </div>
    </section>
  );
}

/** Toggle builtin tools on/off. */
function BuiltinToolsSection() {
  const { t } = useTranslation();
  const showToast = useSettingsToast();
  const [tools, setTools] = useState<tauriCmd.ToolStateDto[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    tauriCmd.getBuiltinToolStates()
      .then(setTools)
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, []);

  async function handleToggle(name: string, enabled: boolean) {
    try {
      await tauriCmd.setBuiltinToolEnabled(name, enabled);
      setTools((prev) =>
        prev.map((t) => (t.name === name ? { ...t, enabled } : t))
      );
      showToast(t("common.saved"));
    } catch (err) {
      console.error("[builtin-tools] failed to toggle", err);
      showToast(t("settings.providerSaveFailed"), "error");
    }
  }

  if (!loaded) return null;
  if (tools.length === 0) return null;

  return (
    <section id="section-builtin-tools" className="app-panel min-w-0 rounded-shell bg-miro-card/95 p-5">
      <h3 className="font-display text-base font-semibold tracking-[-0.02em] text-miro-text">
        {t("settings.builtinToolsTitle")}
      </h3>
      <p className="mt-1 text-xs text-miro-text-secondary">
        {t("settings.builtinToolsHelp")}
      </p>
      <div className="mt-4 space-y-2">
        {tools.map((tool) => {
          const label = BUILTIN_TOOL_I18N_KEYS[tool.name];
          const displayName = label
            ? t(label.nameKey, { defaultValue: tool.name })
            : tool.name;
          const displayDescription = label
            ? t(label.descriptionKey, { defaultValue: tool.description })
            : tool.description;
          return (
            <div
              key={tool.name}
              className="flex min-w-0 items-center justify-between rounded-lg border border-miro-border/20 px-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-miro-text">{displayName}</p>
                <p className="truncate text-xs text-miro-text-secondary">
                  {displayDescription}
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={tool.enabled}
                onClick={() => void handleToggle(tool.name, !tool.enabled)}
                className={`relative ml-3 inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border transition-colors ${
                  tool.enabled ? "border-transparent bg-miro-blue" : "border-(--c-border) bg-(--c-surface-high)"
                }`}
              >
                <span
                  className="block h-3.5 w-3.5 rounded-full bg-white shadow-xs ring-1 ring-black/5 transition-all duration-200"
                  style={{
                    transform: tool.enabled
                      ? 'translate(20px, 3px)'
                      : 'translate(2px, 3px)',
                  }}
                />
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/** MCP server configuration via mcps.json file editor. */
function McpServersSection() {
  const { t } = useTranslation();
  const showToast = useSettingsToast();
  const [configJson, setConfigJson] = useState("");
  const [servers, setServers] = useState<tauriCmd.McpServerStateDto[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveResult, setSaveResult] = useState<string | null>(null);

  async function loadData() {
    try {
      const [json, serverList] = await Promise.all([
        tauriCmd.getMcpConfigJson(),
        tauriCmd.listMcpServers(),
      ]);
      for (const s of serverList) {
        if (s.status.startsWith("error")) {
          console.warn(`[mcp] server "${s.name}" failed: ${s.status}`);
        }
      }
      const pretty = formatMcpJson(json);
      setConfigJson(pretty);
      setServers(serverList);
      setSaveError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      showToast(message, "error");
      console.error("[mcp] failed to load config", err);
    } finally {
      setLoaded(true);
    }
  }

  useEffect(() => {
    void loadData();
  }, []);

  function formatMcpJson(json: string): string {
    try {
      return JSON.stringify(JSON.parse(json), null, 2);
    } catch {
      return json;
    }
  }

  async function handleSave() {
    setSaving(true);
    setSaveError(null);
    setSaveResult(null);
    try {
      const result = await tauriCmd.saveMcpConfigJson(configJson);
      setSaveResult(result || "OK");
      await loadData();
      showToast(t("common.saved"));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setSaveError(msg);
      showToast(msg, "error");
    } finally {
      setSaving(false);
    }
  }

  async function handleToggleServer(name: string, enable: boolean) {
    try {
      await tauriCmd.setMcpServerEnabled(name, enable);
      await loadData();
      showToast(t("common.saved"));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[mcp] toggle failed:", msg);
      showToast(msg, "error");
    }
  }

  if (!loaded) return null;

  return (
    <section id="section-mcp-servers" className="app-panel min-w-0 rounded-shell bg-miro-card/95 p-5">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-display text-base font-semibold tracking-[-0.02em] text-miro-text">
            {t("settings.mcpServersTitle")}
          </h3>
          <p className="mt-1 text-xs text-miro-text-secondary">
            {t("settings.mcpServersHelp")}
          </p>
        </div>
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={saving}
          className="app-primary-button rounded-lg px-3 py-1.5 text-xs"
        >
          {saving ? t("settings.mcpValidating") : t("settings.mcpSaveFile")}
        </button>
      </div>

      <div className="mt-4">
        <textarea
          className="app-input w-full font-mono text-xs leading-relaxed"
          rows={16}
          value={configJson}
          onChange={(e) => {
            setConfigJson(e.target.value);
            setSaveError(null);
            setSaveResult(null);
          }}
          spellCheck={false}
          placeholder={'{\n  "mcpServers": {\n    "filesystem": {\n      "command": "npx",\n      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"]\n    }\n  }\n}'}
        />
      </div>

      {saveError && (
        <p className="mt-2 rounded-md border border-miro-red-light bg-miro-red-light px-2 py-1 text-xs text-miro-red">
          {saveError}
        </p>
      )}

      {saveResult && (
        <pre className="mt-2 whitespace-pre-wrap rounded-md border border-miro-green-light bg-miro-green-light px-2 py-1 text-xs text-miro-green">
          {saveResult}
        </pre>
      )}

      {servers.length > 0 && (
        <div className="mt-4 space-y-2">
          <h4 className="text-xs font-medium text-miro-text-secondary">
            {t("settings.mcpRunningServers")}
          </h4>
          {servers.map((server) => {
            const transportLabel = server.transport === "streamable_http" ? "HTTP" : server.transport.toUpperCase();
            const connectionLabel = server.transport === "streamable_http" || server.transport === "sse"
              ? server.url
              : `${server.command} ${server.args.join(" ")}`.trim();
            const statusClass = server.status === "running"
              ? "bg-miro-green-light text-miro-green"
              : server.status === "disabled"
                ? "bg-miro-bg text-miro-text-secondary"
                : server.status === "starting"
                  ? "bg-miro-amber-light text-miro-amber"
                  : "bg-miro-red-light text-miro-red";
            const statusLabel = server.status === "running"
              ? t("settings.mcpStatusRunning")
              : server.status === "disabled"
                ? t("settings.mcpStatusDisabled")
                : server.status === "starting"
                  ? t("settings.mcpStatusStarting")
                  : server.status === "stopped"
                    ? t("settings.mcpStatusStopped")
                    : t("settings.mcpStatusError", {
                        message: server.status.replace(/^error:\s*/, ""),
                      });
            return (
              <div
                key={server.name}
                className="min-w-0 rounded-lg border border-miro-border/20 px-3 py-2"
              >
                <div className="flex min-w-0 items-center justify-between">
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <p className="min-w-0 max-w-full truncate text-sm font-medium text-miro-text">
                        {server.name}
                      </p>
                      <span
                        className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${statusClass}`}
                      >
                        {statusLabel}
                      </span>
                      <span className="rounded-full bg-miro-bg px-2 py-0.5 text-[10px] font-medium text-miro-text-secondary">
                        {transportLabel}
                      </span>
                      {server.tools.length > 0 && (
                        <span className="text-[10px] text-miro-text-secondary">
                          {t("settings.mcpToolsCount", { count: server.tools.length })}
                        </span>
                      )}
                    </div>
                    <p className="truncate text-xs text-miro-text-secondary">
                      {connectionLabel}
                    </p>
                    {server.tools.length > 0 && (
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {server.tools.map((tool) => (
                          <span
                            key={tool.name}
                            className="rounded bg-miro-bg px-1.5 py-0.5 text-[10px] text-miro-text-secondary"
                            title={tool.description}
                          >
                            {tool.name}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={server.status !== "disabled"}
                    onClick={() => void handleToggleServer(server.name, server.status === "disabled")}
                    className={`relative ml-3 inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border transition-colors ${
                      server.status !== "disabled" ? "border-transparent bg-miro-blue" : "border-(--c-border) bg-(--c-surface-high)"
                    }`}
                    title={server.status === "disabled" ? t("settings.skillEnable", { defaultValue: "Enable" }) : t("settings.skillDisable", { defaultValue: "Disable" })}
                  >
                    <span
                      className="block h-3.5 w-3.5 rounded-full bg-white shadow-xs ring-1 ring-black/5 transition-all duration-200"
                      style={{
                        transform: server.status !== "disabled"
                          ? 'translate(20px, 3px)'
                          : 'translate(2px, 3px)',
                      }}
                    />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

/** Skills management (create, edit, import, enable/disable, delete). */
function SkillsSection() {
  const { t } = useTranslation();
  const [skillsDir, setSkillsDir] = useState<string | null>(null);
  const [slashItems, setSlashItems] = useState<tauriCmd.SlashItemDto[]>([]);
  const [loaded, setLoaded] = useState(false);

  function loadData() {
    tauriCmd.getSkillsDirectory().then(setSkillsDir).catch(() => {});
    tauriCmd
      .listSlashItems()
      .then((items) => setSlashItems(items.filter((i) => i.itemType === "skill")))
      .catch(() => {})
      .finally(() => setLoaded(true));
  }

  useEffect(() => {
    loadData();
  }, []);

  async function handleOpenDirectory() {
    if (!skillsDir) return;
    try {
      const { revealItemInDir } = await import("@tauri-apps/plugin-opener");
      await revealItemInDir(skillsDir);
    } catch (err) {
      console.error("[skills] failed to open directory:", err);
    }
  }

  if (!loaded) return null;

  return (
    <section id="section-skills" className="app-panel min-w-0 rounded-shell bg-miro-card/95 p-5">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-display text-base font-semibold tracking-[-0.02em] text-miro-text">
            {t("settings.skillsTitle")}
          </h3>
          <p className="mt-1 text-xs text-miro-text-secondary">
            {t("settings.skillsHelp")}
          </p>
          {skillsDir && (
            <p className="mt-1 text-[10px] text-miro-text-secondary/60 font-mono truncate">
              {skillsDir}
            </p>
          )}
        </div>
        {skillsDir && (
          <button
            type="button"
            onClick={() => void handleOpenDirectory()}
            className="app-secondary-button rounded-lg px-3 py-1.5 text-xs"
          >
            {t("settings.skillsOpenDir")}
          </button>
        )}
      </div>

      {slashItems.length > 0 && (
        <div className="mt-4 space-y-2">
          {slashItems.map((item) => (
            <div
              key={item.name}
              className="min-w-0 rounded-lg border border-miro-border/20 px-3 py-2"
            >
              <div className="flex min-w-0 items-center gap-2">
                <p className="min-w-0 max-w-full truncate text-sm font-medium text-miro-text">
                  {item.displayName || item.name}
                </p>
                <span className="font-mono text-[10px] text-miro-text-secondary/70">
                  /{item.name}
                </span>
              </div>
              {item.description && (
                <p className="mt-0.5 text-[10px] text-miro-text-secondary">
                  {item.description}
                </p>
              )}
            </div>
          ))}
        </div>
      )}

      {slashItems.length === 0 && (
        <p className="mt-3 text-xs text-miro-text-secondary/60">
          {t("settings.skillsEmpty")}
        </p>
      )}
    </section>
  );
}

export { ToolSettingsSection, SecurityPolicySection, BuiltinToolsSection, McpServersSection, SkillsSection };
