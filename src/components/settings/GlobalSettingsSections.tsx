/**
 * @file GlobalSettingsSections.tsx
 * @description Global settings sections shared across the application.
 *
 * Contains ToolSettingsSection, SecurityPolicySection, BuiltinToolsSection,
 * McpServersSection, and SkillsSection. These are global settings (use global
 * Tauri commands, not per-provider) and are displayed in AppSettingsView.
 */
import { useEffect, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import * as tauriCmd from "../../services/tauriCommands";
import { useSettingsToast } from "./AppSettingsView";
import { IconSettings, IconTrash } from "../common/Icon";
import { confirmDialog } from "../common/confirmDialog";

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

  useEffect(() => {
    tauriCmd.getToolSettings().then((loaded) => {
      setSettings(loaded);
      setDraft(loaded);
    }).catch(() => {});
  }, []);

  if (!settings || !draft) return null;

  async function handleSave() {
    if (!draft) return;
    setSaving(true);
    try {
      const updated = await tauriCmd.updateToolSettings({
        max_iterations: draft!.max_iterations,
        max_consecutive_failures: draft!.max_consecutive_failures,
        approval_timeout_secs: draft!.approval_timeout_secs,
        tool_execution_timeout_secs: draft!.tool_execution_timeout_secs,
      });
      setSettings(updated);
      setDraft(updated);
      showToast(t("common.saved"));
    } catch (err) {
      console.error("[tool-settings] failed to save", err);
      showToast(t("settings.providerSaveFailed"), "error");
    } finally {
      setSaving(false);
    }
  }

  function updateField<K extends keyof tauriCmd.ToolSettingsDto>(key: K, value: tauriCmd.ToolSettingsDto[K]) {
    setDraft((prev) => prev ? { ...prev, [key]: value } : prev);
  }

  return (
    <section id="section-tool-settings" className="app-panel min-w-0 rounded-shell bg-white/95 p-5">
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
            <div>
              <label className="mb-1 block text-sm font-medium text-miro-text">
                {t("settings.maxIterations")}
              </label>
              <div className="flex min-w-0 flex-wrap items-center gap-3">
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={draft.max_iterations}
                  className="w-24 rounded-md border border-miro-border/30 bg-white px-3 py-1.5 text-sm text-miro-text focus:border-miro-blue focus:outline-none"
                  onChange={(e) => {
                    const v = parseInt(e.target.value, 10);
                    if (!isNaN(v) && v >= 1 && v <= 100) {
                      updateField("max_iterations", v);
                    }
                  }}
                />
                <span className="min-w-0 flex-1 text-xs text-miro-text-secondary">
                  {t("settings.maxIterationsHelp")}
                </span>
              </div>
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-miro-text">
                {t("settings.maxConsecutiveFailures")}
              </label>
              <div className="flex min-w-0 flex-wrap items-center gap-3">
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={draft.max_consecutive_failures}
                  className="w-24 rounded-md border border-miro-border/30 bg-white px-3 py-1.5 text-sm text-miro-text focus:border-miro-blue focus:outline-none"
                  onChange={(e) => {
                    const v = parseInt(e.target.value, 10);
                    if (!isNaN(v) && v >= 1 && v <= 20) {
                      updateField("max_consecutive_failures", v);
                    }
                  }}
                />
                <span className="min-w-0 flex-1 text-xs text-miro-text-secondary">
                  {t("settings.maxConsecutiveFailuresHelp")}
                </span>
              </div>
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-miro-text">
                {t("settings.approvalTimeout")}
              </label>
              <div className="flex min-w-0 flex-wrap items-center gap-3">
                <input
                  type="number"
                  min={10}
                  max={600}
                  value={draft.approval_timeout_secs}
                  className="w-24 rounded-md border border-miro-border/30 bg-white px-3 py-1.5 text-sm text-miro-text focus:border-miro-blue focus:outline-none"
                  onChange={(e) => {
                    const v = parseInt(e.target.value, 10);
                    if (!isNaN(v) && v >= 10 && v <= 600) {
                      updateField("approval_timeout_secs", v);
                    }
                  }}
                />
                <span className="min-w-0 flex-1 text-xs text-miro-text-secondary">
                  {t("settings.approvalTimeoutHelp")}
                </span>
              </div>
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-miro-text">
                {t("settings.toolExecutionTimeout")}
              </label>
              <div className="flex min-w-0 flex-wrap items-center gap-3">
                <input
                  type="number"
                  min={10}
                  max={600}
                  value={draft.tool_execution_timeout_secs}
                  className="w-24 rounded-md border border-miro-border/30 bg-white px-3 py-1.5 text-sm text-miro-text focus:border-miro-blue focus:outline-none"
                  onChange={(e) => {
                    const v = parseInt(e.target.value, 10);
                    if (!isNaN(v) && v >= 10 && v <= 600) {
                      updateField("tool_execution_timeout_secs", v);
                    }
                  }}
                />
                <span className="min-w-0 flex-1 text-xs text-miro-text-secondary">
                  {t("settings.toolExecutionTimeoutHelp")}
                </span>
              </div>
            </div>
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
    <section id="section-security-policy" className="app-panel min-w-0 rounded-shell bg-white/95 p-5">
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
                ? "border-miro-blue bg-blue-50/60"
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
    <section id="section-builtin-tools" className="app-panel min-w-0 rounded-shell bg-white/95 p-5">
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
                className={`relative ml-3 inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full transition-colors ${
                  tool.enabled ? "bg-miro-blue" : "bg-miro-border/40"
                }`}
              >
                <span
                  className="block h-3.5 w-3.5 rounded-full bg-white shadow-sm transition-all duration-200"
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

/** MCP server management (add, edit, enable/disable, remove). */
function McpServersSection() {
  const { t } = useTranslation();
  const showToast = useSettingsToast();
  const [servers, setServers] = useState<tauriCmd.McpServerStateDto[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editingMcpServerName, setEditingMcpServerName] = useState<string | null>(null);
  const [jsonInput, setJsonInput] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [pendingServerNames, setPendingServerNames] = useState<Set<string>>(
    () => new Set()
  );

  function setServerPending(name: string, pending: boolean) {
    setPendingServerNames((prev) => {
      const next = new Set(prev);
      if (pending) {
        next.add(name);
      } else {
        next.delete(name);
      }
      return next;
    });
  }

  async function loadServers() {
    try {
      const nextServers = await tauriCmd.listMcpServers();
      setServers(nextServers);
      setLoadError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setLoadError(message);
      console.error("[mcp] failed to load servers", err);
    } finally {
      setLoaded(true);
    }
  }

  async function handleToggleEnabled(name: string, enabled: boolean) {
    setServerPending(name, true);
    setServerErrors((prev) => {
      const next = { ...prev };
      delete next[name];
      return next;
    });
    try {
      await tauriCmd.setMcpServerEnabled(name, enabled);
      await loadServers();
      showToast(t("common.saved"));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setServerErrors((prev) => ({ ...prev, [name]: message }));
      await loadServers();
      showToast(message, "error");
    } finally {
      setServerPending(name, false);
    }
  }

  useEffect(() => {
    void loadServers();
  }, []);

  function normalizeMcpTransport(value: unknown): "stdio" | "streamable_http" | "sse" {
    const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
    if (!raw || raw === "stdio") return "stdio";
    if (raw === "http" || raw === "streamable-http" || raw === "streamable_http") {
      return "streamable_http";
    }
    if (raw === "sse" || raw === "legacy-sse" || raw === "legacy_sse") {
      return "sse";
    }
    return "stdio";
  }

  function readStringMap(value: unknown): Record<string, string> | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return undefined;
    }
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        String(item),
      ])
    );
  }

  function readMcpServerConfig(
    name: string,
    value: unknown
  ): { ok: true; config: tauriCmd.McpServerConfig } | { ok: false; error: string } {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return { ok: false, error: t("settings.mcpErrorServerMustBeObject", { name }) };
    }

    const serverObj = value as Record<string, unknown>;
    const hasCommand = typeof serverObj.command === "string" && serverObj.command.trim().length > 0;
    const hasUrl = typeof serverObj.url === "string" && serverObj.url.trim().length > 0;
    const transport = normalizeMcpTransport(
      serverObj.transport ?? (hasUrl && !hasCommand ? "streamable_http" : "stdio")
    );

    if (transport === "stdio" && !hasCommand) {
      return { ok: false, error: t("settings.mcpErrorCommandRequired", { name }) };
    }
    if ((transport === "streamable_http" || transport === "sse") && !hasUrl) {
      return { ok: false, error: t("settings.mcpErrorUrlRequired", { name }) };
    }

    return {
      ok: true,
      config: {
        transport,
        command: hasCommand ? String(serverObj.command).trim() : "",
        args: Array.isArray(serverObj.args) ? serverObj.args.map(String) : [],
        env: readStringMap(serverObj.env),
        url: hasUrl ? String(serverObj.url).trim() : "",
        headers: readStringMap(serverObj.headers),
      },
    };
  }

  /** Parse MCP JSON from common client shapes and transport-aware HTTP configs. */
  function parseAndValidate(json: string):
    | { ok: true; servers: Array<{ name: string; config: tauriCmd.McpServerConfig }> }
    | { ok: false; error: string } {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch (e) {
      return { ok: false, error: t("settings.mcpErrorJsonParse", { message: (e as SyntaxError).message }) };
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { ok: false, error: t("settings.mcpErrorJsonMustBeObject") };
    }
    const obj = parsed as Record<string, unknown>;

    const wrappedServers = obj.mcpServers ?? obj.servers;
    if (typeof wrappedServers === "object" && wrappedServers !== null && !Array.isArray(wrappedServers)) {
      const serversMap = wrappedServers as Record<string, unknown>;
      const results: Array<{ name: string; config: tauriCmd.McpServerConfig }> = [];
      for (const [name, value] of Object.entries(serversMap)) {
        const configResult = readMcpServerConfig(name, value);
        if (!configResult.ok) return configResult;
        results.push({
          name: name.trim(),
          config: configResult.config,
        });
      }
      if (results.length === 0) {
        return { ok: false, error: t("settings.mcpErrorServerMapEmpty") };
      }
      return { ok: true, servers: results };
    }

    if (typeof obj.name === "string" && obj.name.trim()) {
      const configResult = readMcpServerConfig(obj.name.trim(), obj);
      if (!configResult.ok) return configResult;
      return { ok: true, servers: [{ name: obj.name.trim(), config: configResult.config }] };
    }

    const entries = Object.entries(obj);
    const hasServerLikeEntries = entries.some(
      ([, v]) =>
        typeof v === "object" &&
        v !== null &&
        !Array.isArray(v) &&
        ("command" in (v as Record<string, unknown>) || "url" in (v as Record<string, unknown>))
    );
    if (hasServerLikeEntries) {
      const results: Array<{ name: string; config: tauriCmd.McpServerConfig }> = [];
      for (const [name, value] of entries) {
        if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
        const configResult = readMcpServerConfig(name, value);
        if (!configResult.ok) return configResult;
        results.push({
          name: name.trim(),
          config: configResult.config,
        });
      }
      if (results.length === 0) {
        return { ok: false, error: t("settings.mcpErrorNoValidServers") };
      }
      return { ok: true, servers: results };
    }

    return { ok: false, error: t("settings.mcpErrorExpectedShape") };
  }

  async function handleAdd(e: FormEvent) {
    e.preventDefault();
    setAddError(null);

    const result = parseAndValidate(jsonInput.trim());
    if (!result.ok) {
      setAddError(result.error);
      return;
    }
    if (editingMcpServerName) {
      const [target] = result.servers;
      if (result.servers.length !== 1 || target?.name !== editingMcpServerName) {
        setAddError(t("settings.mcpEditNameLocked"));
        return;
      }
    }

    setAdding(true);
    try {
      // Add servers one by one; stop on first failure
      for (const { name, config } of result.servers) {
        await tauriCmd.addMcpServer({ name, config });
      }
      setJsonInput("");
      setEditingMcpServerName(null);
      setShowForm(false);
      await loadServers();
      showToast(t("common.saved"));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setAddError(msg);
      showToast(msg, "error");
    } finally {
      setAdding(false);
    }
  }

  function handleEditMcpServer(server: tauriCmd.McpServerStateDto) {
    setEditingMcpServerName(server.name);
    setAddError(null);
    setJsonInput(
      JSON.stringify(
        {
          name: server.name,
          transport: server.transport,
          command: server.command || undefined,
          args: server.args,
          env: server.env,
          url: server.url || undefined,
          headers: server.headers,
        },
        null,
        2
      )
    );
    setShowForm(true);
  }

  async function handleRemove(name: string) {
    setServerPending(name, true);
    setServerErrors((prev) => {
      const next = { ...prev };
      delete next[name];
      return next;
    });
    try {
      await tauriCmd.removeMcpServer(name);
      await loadServers();
      showToast(t("common.saved"));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setServerErrors((prev) => ({ ...prev, [name]: message }));
      showToast(message, "error");
      console.error("[mcp] failed to remove server", err);
    } finally {
      setServerPending(name, false);
    }
  }

  if (!loaded) return null;

  const exampleJson = JSON.stringify(
    {
      mcpServers: {
        filesystem: {
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"],
        },
        exa: {
          url: "https://mcp.exa.ai/mcp",
          headers: {
            "x-api-key": "YOUR_KEY",
          },
        },
      },
    },
    null,
    2
  );

  function getStatusPillClassName(status: string): string {
    if (status === "running") {
      return "bg-emerald-50 text-emerald-700";
    }
    if (status === "disabled") {
      return "bg-miro-bg text-miro-text-secondary";
    }
    if (status === "starting") {
      return "bg-amber-50 text-amber-700";
    }
    return "bg-red-50 text-red-600";
  }

  function getMcpStatusLabel(status: string): string {
    if (status === "running") return t("settings.mcpStatusRunning");
    if (status === "disabled") return t("settings.mcpStatusDisabled");
    if (status === "starting") return t("settings.mcpStatusStarting");
    if (status === "stopped") return t("settings.mcpStatusStopped");
    if (status.startsWith("error:")) {
      return t("settings.mcpStatusError", {
        message: status.replace(/^error:\s*/, ""),
      });
    }
    return status;
  }

  return (
    <section id="section-mcp-servers" className="app-panel min-w-0 rounded-shell bg-white/95 p-5">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-display text-base font-semibold tracking-[-0.02em] text-miro-text">
            {t("settings.mcpServersTitle")}
          </h3>
          <p className="mt-1 text-xs text-miro-text-secondary">
            {t("settings.mcpServersHelp")}
          </p>
        </div>
        {!showForm && (
          <button
            type="button"
            onClick={() => {
              setEditingMcpServerName(null);
              setJsonInput("");
              setAddError(null);
              setShowForm(true);
            }}
            className="app-secondary-button rounded-lg px-3 py-1.5 text-xs"
          >
            + {t("settings.mcpAddServer")}
          </button>
        )}
      </div>

      {showForm && (
        <form onSubmit={(e) => void handleAdd(e)} className="mt-4 space-y-3">
          <div>
            <label className="text-xs font-medium text-miro-text">
              {t("settings.mcpJsonConfig")} *
            </label>
            <textarea
              className="app-input mt-1 w-full font-mono text-xs"
              rows={8}
              value={jsonInput}
              onChange={(e) => setJsonInput(e.target.value)}
              placeholder={exampleJson}
              spellCheck={false}
            />
          </div>
          {addError && (
            <p className="rounded-md border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-700">
              {addError}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              type="submit"
              disabled={adding}
              className="app-primary-button rounded-lg px-4 py-1.5 text-xs"
            >
              {adding
                ? t("settings.mcpValidating")
                : editingMcpServerName
                  ? t("settings.mcpSaveServer")
                  : t("settings.mcpAddConfirm")}
            </button>
            <button
              type="button"
              onClick={() => {
                setShowForm(false);
                setAddError(null);
                setEditingMcpServerName(null);
              }}
              className="app-secondary-button rounded-lg px-4 py-1.5 text-xs"
            >
              {t("settings.mcpCancel")}
            </button>
          </div>
        </form>
      )}

      {loadError && (
        <p className="mt-3 rounded-md border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-700">
          {loadError}
        </p>
      )}

      {servers.length > 0 && (
        <div className="mt-4 space-y-2">
          {servers.map((server) => {
            const isPending = pendingServerNames.has(server.name);
            const serverError = serverErrors[server.name];
            const pendingLabel = server.enabled
              ? t("settings.mcpDisabling")
              : t("settings.mcpValidating");
            const transportLabel = server.transport === "streamable_http" ? "HTTP" : server.transport.toUpperCase();
            const connectionLabel = server.transport === "streamable_http" || server.transport === "sse"
              ? server.url
              : `${server.command} ${server.args.join(" ")}`.trim();
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
                      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${
                        getStatusPillClassName(server.status)
                      }`}
                    >
                      {isPending ? pendingLabel : getMcpStatusLabel(server.status)}
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
                <div className="ml-2 flex shrink-0 items-center gap-2">
                  <button
                    type="button"
                    disabled={isPending}
                    onClick={() => handleEditMcpServer(server)}
                    className={`rounded-md px-2 py-1 text-xs font-medium text-miro-text-secondary transition-colors hover:bg-miro-bg hover:text-miro-text ${
                      isPending ? "cursor-wait opacity-50" : ""
                    }`}
                  >
                    {t("settings.mcpEditServer")}
                  </button>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={server.enabled}
                    aria-busy={isPending || undefined}
                    disabled={isPending}
                    onClick={() => void handleToggleEnabled(server.name, !server.enabled)}
                    className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full transition-colors ${
                      server.enabled ? "bg-miro-blue" : "bg-miro-border/40"
                    } ${
                      isPending ? "cursor-wait opacity-60" : "cursor-pointer"
                    }`}
                    title={server.enabled ? t("settings.mcpDisableServer") : t("settings.mcpEnableServer")}
                  >
                    <span
                      className="block h-3.5 w-3.5 rounded-full bg-white shadow transition-all duration-200"
                      style={{
                        transform: server.enabled
                          ? 'translate(20px, 3px)'
                          : 'translate(2px, 3px)',
                      }}
                    />
                  </button>
                  <button
                    type="button"
                    disabled={isPending}
                    onClick={() => void handleRemove(server.name)}
                    className={`rounded-md p-1.5 text-miro-text-secondary/50 transition-colors hover:bg-red-50 hover:text-red-600 ${
                      isPending ? "cursor-wait opacity-50" : ""
                    }`}
                    title={t("settings.mcpRemoveServer")}
                  >
                    <IconTrash size={14} />
                  </button>
                </div>
              </div>
              {serverError && (
                <p className="mt-2 rounded-md border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-700">
                  {serverError}
                </p>
              )}
            </div>
            );
          })}
        </div>
      )}

      {servers.length === 0 && !showForm && (
        <p className="mt-3 text-xs text-miro-text-secondary/60">
          {t("settings.mcpNoServers")}
        </p>
      )}
    </section>
  );
}

/** Skills management (create, edit, import, enable/disable, delete). */
function SkillsSection() {
  const { t } = useTranslation();
  const [skills, setSkills] = useState<tauriCmd.SkillDto[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [editingSkill, setEditingSkill] = useState<tauriCmd.SkillDto | null>(null);
  const [showForm, setShowForm] = useState(false);

  // Form state
  const [formName, setFormName] = useState("");
  const [formDisplayName, setFormDisplayName] = useState("");
  const [formDescription, setFormDescription] = useState("");
  const [formTriggerType, setFormTriggerType] = useState("SLASH");
  const [formTemplate, setFormTemplate] = useState("");
  const [formVariables, setFormVariables] = useState("");
  const [formBoundTools, setFormBoundTools] = useState("");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [skillsDir, setSkillsDir] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  function loadSkills() {
    tauriCmd
      .listSkills()
      .then(setSkills)
      .catch(() => {})
      .finally(() => setLoaded(true));
    tauriCmd.getSkillsDirectory().then(setSkillsDir).catch(() => {});
  }

  useEffect(() => {
    loadSkills();
  }, []);

  function resetForm() {
    setFormName("");
    setFormDisplayName("");
    setFormDescription("");
    setFormTriggerType("SLASH");
    setFormTemplate("");
    setFormVariables("");
    setFormBoundTools("");
    setFormError(null);
    setImportError(null);
    setEditingSkill(null);
    setShowForm(false);
  }

  function startEdit(skill: tauriCmd.SkillDto) {
    setEditingSkill(skill);
    setFormName(skill.name);
    setFormDisplayName(skill.displayName);
    setFormDescription(skill.description);
    setFormTriggerType(skill.triggerType);
    setFormTemplate(skill.promptTemplate);
    setFormVariables(skill.variablesJson || "[]");
    setFormBoundTools(skill.boundToolsJson || "[]");
    setFormError(null);
    setShowForm(true);
  }

  function startCreate() {
    resetForm();
    setShowForm(true);
  }

  async function handleImportSkill() {
    setImporting(true);
    setImportError(null);
    try {
      const selected = await openDialog({ directory: true, multiple: false });
      if (typeof selected === "string" && selected) {
        await tauriCmd.importSkill(selected);
        setImportError(null);
        loadSkills();
      }
    } catch (err) {
      console.warn("Import skill failed:", err);
      setImportError(err instanceof Error ? err.message : String(err));
    } finally {
      setImporting(false);
    }
  }

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    setFormError(null);

    const trimmedName = formName.trim();
    if (!trimmedName) {
      setFormError(t("settings.skillNameRequired"));
      return;
    }
    if (!formTemplate.trim()) {
      setFormError(t("settings.skillTemplateRequired"));
      return;
    }

    // Validate JSON fields
    if (formVariables.trim()) {
      try {
        JSON.parse(formVariables);
      } catch {
        setFormError(t("settings.skillVariablesJsonParseError"));
        return;
      }
    }
    if (formBoundTools.trim()) {
      try {
        JSON.parse(formBoundTools);
      } catch {
        setFormError(t("settings.skillBoundToolsJsonParseError"));
        return;
      }
    }

    setSaving(true);
    try {
      const input: tauriCmd.CreateSkillInput = {
        name: trimmedName,
        displayName: formDisplayName.trim(),
        description: formDescription.trim(),
        triggerType: formTriggerType,
        promptTemplate: formTemplate,
        variablesJson: formVariables.trim() || "[]",
        boundToolsJson: formBoundTools.trim() || "[]",
      };
      if (editingSkill) {
        await tauriCmd.updateSkill(input);
      } else {
        await tauriCmd.createSkill(input);
      }
      resetForm();
      loadSkills();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    if (!(await confirmDialog({ message: t("settings.skillConfirmDelete") }))) return;
    try {
      await tauriCmd.deleteSkill(id);
      loadSkills();
    } catch (err) {
      console.error("[skills] failed to delete", err);
    }
  }

  async function handleToggle(skill: tauriCmd.SkillDto) {
    try {
      await tauriCmd.setSkillEnabled(skill.id, !skill.enabled);
      loadSkills();
    } catch (err) {
      console.error("[skills] failed to toggle", err);
    }
  }

  if (!loaded) return null;

  const triggerBadge = (type: string) => {
    switch (type) {
      case "ALWAYS":
        return (
          <span className="inline-flex items-center rounded-full bg-blue-50 px-2 py-0.5 text-[10px] font-medium text-blue-700">
            {t("settings.skillTriggerAlwaysDesc")}
          </span>
        );
      case "SLASH":
        return (
          <span className="inline-flex items-center rounded-full bg-purple-50 px-2 py-0.5 text-[10px] font-medium text-purple-700">
            {t("settings.skillTriggerSlashDesc")}
          </span>
        );
      default:
        return (
          <span className="inline-flex items-center rounded-full bg-gray-50 px-2 py-0.5 text-[10px] font-medium text-gray-600">
            {t("settings.skillTriggerManualDesc")}
          </span>
        );
    }
  };

  return (
    <section id="section-skills" className="app-panel min-w-0 rounded-shell bg-white/95 p-5">
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
          <p className="mt-1 text-[10px] text-miro-text-secondary/70">
            {t("settings.skillImportHelp")}
          </p>
        </div>
        {!showForm && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void handleImportSkill()}
              disabled={importing}
              className="app-secondary-button rounded-lg px-3 py-1.5 text-xs"
            >
              {importing ? t("settings.skillImporting") : t("settings.skillImport")}
            </button>
            <button
              type="button"
              onClick={startCreate}
              className="app-secondary-button rounded-lg px-3 py-1.5 text-xs"
            >
              + {t("settings.skillAdd")}
            </button>
          </div>
        )}
      </div>

      {importError && !showForm && (
        <p className="mt-3 rounded-md border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-700">
          {importError}
        </p>
      )}

      {showForm && (
        <form onSubmit={(e) => void handleSave(e)} className="mt-4 space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="text-xs font-medium text-miro-text">
                {t("settings.skillName")} *
              </label>
              <input
                type="text"
                className="app-input mt-1 w-full text-xs"
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                placeholder={t("settings.skillNamePlaceholder")}
                disabled={!!editingSkill}
              />
            </div>
            <div>
              <label className="text-xs font-medium text-miro-text">
                {t("settings.skillDisplayName")}
              </label>
              <input
                type="text"
                className="app-input mt-1 w-full text-xs"
                value={formDisplayName}
                onChange={(e) => setFormDisplayName(e.target.value)}
                placeholder={t("settings.skillDisplayNamePlaceholder")}
              />
            </div>
          </div>

          <div>
            <label className="text-xs font-medium text-miro-text">
              {t("settings.skillDescription")}
            </label>
            <input
              type="text"
              className="app-input mt-1 w-full text-xs"
              value={formDescription}
              onChange={(e) => setFormDescription(e.target.value)}
              placeholder={t("settings.skillDescriptionPlaceholder")}
            />
          </div>

          <div>
            <label className="text-xs font-medium text-miro-text">
              {t("settings.skillTriggerType")}
            </label>
            <div className="mt-1 flex flex-wrap gap-3">
              {(["ALWAYS", "SLASH", "MANUAL"] as const).map((type) => (
                <label
                  key={type}
                  className="flex cursor-pointer items-center gap-1.5 text-xs"
                >
                  <input
                    type="radio"
                    name="triggerType"
                    value={type}
                    checked={formTriggerType === type}
                    onChange={() => setFormTriggerType(type)}
                    className="accent-miro-blue"
                  />
                  {t(`settings.skillTrigger${type.charAt(0) + type.slice(1).toLowerCase()}`)}
                </label>
              ))}
            </div>
          </div>

          <div>
            <label className="text-xs font-medium text-miro-text">
              {t("settings.skillPromptTemplate")} *
            </label>
            <p className="mb-1 text-[10px] text-miro-text-secondary">
              {t("settings.skillPromptTemplateHelp")}
            </p>
            <textarea
              className="app-input w-full font-mono text-xs"
              rows={6}
              value={formTemplate}
              onChange={(e) => setFormTemplate(e.target.value)}
              placeholder="You are a {{role}} expert. Help me with {{topic}}."
              spellCheck={false}
            />
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="text-xs font-medium text-miro-text">
                {t("settings.skillVariables")}
              </label>
              <input
                type="text"
                className="app-input mt-1 w-full font-mono text-xs"
                value={formVariables}
                onChange={(e) => setFormVariables(e.target.value)}
                placeholder={t("settings.skillVariablesPlaceholder")}
              />
            </div>
            <div>
              <label className="text-xs font-medium text-miro-text">
                {t("settings.skillBoundTools")}
              </label>
              <input
                type="text"
                className="app-input mt-1 w-full font-mono text-xs"
                value={formBoundTools}
                onChange={(e) => setFormBoundTools(e.target.value)}
                placeholder={t("settings.skillBoundToolsPlaceholder")}
              />
            </div>
          </div>

          {formError && (
            <p className="rounded-md border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-700">
              {formError}
            </p>
          )}

          <div className="flex flex-wrap gap-2">
            <button
              type="submit"
              disabled={saving}
              className="app-primary-button rounded-lg px-4 py-1.5 text-xs"
            >
              {saving
                ? t("common.saving")
                : editingSkill
                  ? t("settings.skillSave")
                  : t("settings.skillAdd")}
            </button>
            <button
              type="button"
              onClick={resetForm}
              className="app-secondary-button rounded-lg px-4 py-1.5 text-xs"
            >
              {t("settings.skillCancel")}
            </button>
          </div>
        </form>
      )}

      {skills.length > 0 && (
        <div className="mt-4 space-y-2">
          {skills.map((skill) => (
            <div
              key={skill.id}
              className={`min-w-0 rounded-lg border px-3 py-2 ${
                skill.enabled
                  ? "border-miro-border/20"
                  : "border-miro-border/10 bg-gray-50/50 opacity-60"
              }`}
            >
              <div className="flex min-w-0 items-center justify-between">
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <p className="min-w-0 max-w-full truncate text-sm font-medium text-miro-text">
                      {skill.displayName || skill.name}
                    </p>
                    {triggerBadge(skill.triggerType)}
                    {skill.description && (
                      <span className="max-w-[200px] truncate text-[10px] text-miro-text-secondary">
                        {skill.description}
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 truncate font-mono text-[10px] text-miro-text-secondary/70">
                    /{skill.name}
                  </p>
                </div>
                <div className="ml-2 flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={() => handleToggle(skill)}
                    className={`rounded-md px-2 py-1 text-[10px] font-medium transition-colors ${
                      skill.enabled
                        ? "bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
                        : "bg-gray-100 text-gray-500 hover:bg-gray-200"
                    }`}
                  >
                    {skill.enabled ? t("settings.skillDisable") : t("settings.skillEnable")}
                  </button>
                  <button
                    type="button"
                    onClick={() => startEdit(skill)}
                    className="rounded-md p-1.5 text-miro-text-secondary/50 transition-colors hover:bg-blue-50 hover:text-blue-600"
                    title={t("settings.skillEdit")}
                  >
                    <IconSettings size={13} />
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleDelete(skill.id)}
                    className="rounded-md p-1.5 text-miro-text-secondary/50 transition-colors hover:bg-red-50 hover:text-red-600"
                    title={t("settings.skillDelete")}
                  >
                    <IconTrash size={13} />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {skills.length === 0 && !showForm && (
        <p className="mt-3 text-xs text-miro-text-secondary/60">
          {t("settings.skillsEmpty")}
        </p>
      )}
    </section>
  );
}

export { ToolSettingsSection, SecurityPolicySection, BuiltinToolsSection, McpServersSection, SkillsSection };
