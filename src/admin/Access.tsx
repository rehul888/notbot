// Admin > Settings: replace the NotPanel API key, and manage who is an admin. English only.
import { useState } from "preact/hooks";
import { looksLikeNotPanelKey } from "../../shared/brand";
import { api, ApiError } from "../api";
import { Icon } from "../icons";
import { meStore } from "../store";
import { confirmDialog } from "../tg";
import { Chip, Field, List, Notice, Row, Section, toast } from "../ui";
import { Kv, fail } from "./AdminRoutes";

export interface Owners {
  env: number[];
  added: number[];
}

function keyProblem(e: unknown): string | null {
  if (!(e instanceof ApiError)) return null;
  const d = typeof e.details?.message === "string" ? e.details.message : "";
  if (e.code === "NOT_NOTPANEL_KEY") return `This isn't a NotPanel API key.${d ? ` ${d}` : ""}`;
  if (e.code === "NOTPANEL_REJECTED") return d || "NotPanel didn't accept this key. Check that you copied all of it and that it is active.";
  return null;
}

export function NotPanelKeySection({ hint, source, onSaved }: { hint: string | null; source: "env" | "saved" | undefined; onSaved: (hint: string | null) => void }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const key = value.trim();

  const save = async () => {
    if (busy || !key) return;
    if (!looksLikeNotPanelKey(key)) return void setErr("This isn't a NotPanel API key. It starts with np_live_.");
    // Orders are tracked by their NotPanel ID under the key that placed them
    if (hint && !(await confirmDialog("Only use a key from the same NotPanel account. A key from a different account can't track orders that were placed with the current key. Save the new key?", "Save key", "Cancel"))) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ ok: boolean; key_hint?: string }>("/admin/notpanel-key", { method: "PUT", body: { key } });
      setValue("");
      onSaved(r.key_hint ?? null);
      toast("NotPanel key saved", "ok");
    } catch (e) {
      const p = keyProblem(e);
      if (p) setErr(p);
      else fail(e);
    }
    setBusy(false);
  };

  return (
    <Section
      header="NotPanel API key"
      footer="The key is checked with NotPanel before it is saved. A key saved here is used instead of the one set on your host. Use a key from the same NotPanel account: orders placed with an old key from a different account can no longer be tracked. Only the last characters of the key are ever shown."
    >
      <dl class="card">
        <Kv label="Current key">
          <span class="mono">{hint ?? "missing"}</span>
        </Kv>
        {source ? <Kv label="Stored">{source === "saved" ? "Saved in the app" : "Set on the host"}</Kv> : null}
      </dl>
      <Field
        id="np-key"
        label="Replace key"
        type="password"
        lead="plug"
        dir="ltr"
        value={value}
        onInput={(v) => (setValue(v), setErr(null))}
        placeholder="np_live_..."
        error={err}
        enterKeyHint="go"
      />
      <button type="button" class="btn sm soft inline" disabled={busy || !key} aria-busy={busy ? "true" : undefined} onClick={save}>
        {busy ? <span class="spin" aria-hidden="true" /> : null}
        Check and save key
      </button>
    </Section>
  );
}

export function AdminsSection({ owners, onChanged }: { owners: Owners; onChanged: (o: Owners) => void }) {
  const myId = meStore.get()?.id;
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const write = async (added: number[]) => {
    setBusy(true);
    try {
      await api("/admin/owners", { method: "PUT", body: { added } });
      onChanged({ ...owners, added });
      return true;
    } catch (e) {
      if (e instanceof ApiError && (e.code === "LAST_OWNER" || e.code === "INVALID_VALUE")) toast("You can't remove the last admin.", "error");
      else fail(e);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const add = async () => {
    const id = Number(value.trim());
    if (!/^\d{5,15}$/.test(value.trim())) return void setErr("A Telegram ID is a number of 5 to 15 digits. People can find theirs with @userinfobot.");
    if (owners.env.includes(id) || owners.added.includes(id)) return void setErr("That person is already an admin.");
    setErr(null);
    if (await write([...owners.added, id])) {
      setValue("");
      toast("Admin added", "ok");
    }
  };
  const remove = async (id: number) => {
    const self = id === myId;
    const ok = await confirmDialog(self ? "Remove yourself as an admin? You will lose access to this panel." : `Remove ${id} as an admin?`, "Remove", "Cancel", true);
    if (ok && (await write(owners.added.filter((x) => x !== id)))) toast("Admin removed", "ok");
  };

  return (
    <Section header="Admins" footer="Admins can change prices, branding and settings. Admins set on your host (OWNER_IDS) can only be changed there.">
      {owners.env.length || owners.added.length ? (
        <List>
          {owners.env.map((id) => (
            <Row key={`e${id}`} title={<span class="num">{id}</span>} meta={id === myId ? "You · set on the host" : "Set on the host"} chevron={false} />
          ))}
          {owners.added.map((id) => (
            <Row
              key={`a${id}`}
              title={<span class="num">{id}</span>}
              meta={id === myId ? "You" : "Added here"}
              control={
                <Chip label={`Remove admin ${id}`} disabled={busy} onClick={() => remove(id)}>
                  <Icon name="close" size={14} stroke={2.4} />
                  Remove
                </Chip>
              }
            />
          ))}
        </List>
      ) : (
        <Notice tone="warn">No admins found.</Notice>
      )}
      <Field
        id="admin-add"
        label="Add an admin"
        inputMode="numeric"
        dir="ltr"
        lead="users"
        value={value}
        onInput={(v) => (setValue(v.replace(/\D/g, "")), setErr(null))}
        placeholder="Telegram ID, e.g. 123456789"
        error={err}
        enterKeyHint="done"
      />
      <button type="button" class="btn sm soft inline" disabled={busy || !value.trim()} onClick={add}>
        Add admin
      </button>
    </Section>
  );
}
