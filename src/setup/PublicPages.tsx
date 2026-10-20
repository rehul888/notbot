// What a plain browser sees at the app URL (outside Telegram): the one-time setup wizard for a fresh deployment, or a
// branded "open the bot in Telegram" page once it is configured. English only, like the admin panel.
import { useEffect, useRef, useState } from "preact/hooks";
import type { PublicStatus, SetupStatus, SetupStep } from "../../shared/brand";
import { looksLikeNotPanelKey } from "../../shared/brand";
import { ApiError, api } from "../api";
import { Icon } from "../icons";
import { applyBrand, brandStore } from "../theme";
import { BrandMark, ErrorState, Field, FlowSteps, LargeTitle, List, Notice, Row, Screen, Section, Skeleton } from "../ui";

const TOKEN_KEY = "np_setup_token";
const STEP_ORDER: SetupStep[] = ["webhook", "menu", "texts0", "texts1", "commands"];
const STEP_LABEL: Record<SetupStep, [string, string]> = {
  webhook: ["Connect the bot", "Telegram sends messages and payments to this app"],
  menu: ["Add the app button", "The menu button that opens the Mini App, plus your bot's name and photo"],
  texts0: ["Bot name and description (1 of 2)", "Written in the first five languages"],
  texts1: ["Bot name and description (2 of 2)", "Written in the other five languages"],
  commands: ["Bot commands", "The command list people see in the chat"],
};

/** Plain-language message for an API failure during setup. */
function problem(e: unknown, where: "token" | "key" | "run" | "other" = "other"): string {
  if (!(e instanceof ApiError)) return "Something went wrong. Try again.";
  const d = typeof e.details?.message === "string" ? e.details.message : "";
  switch (e.code) {
    case "NETWORK":
      return "Can't reach the server. Check your connection and try again.";
    case "WRONG_BOT_TOKEN":
      return "That token doesn't match this app's bot. Copy it again from @BotFather (it looks like 123456789:AAH...).";
    case "TOO_MANY_ATTEMPTS":
      return "Too many wrong tokens from this network. Try again in an hour.";
    case "NOT_NOTPANEL_KEY":
      return "This isn't a NotPanel API key." + (d ? ` ${d}` : "");
    case "NOTPANEL_REJECTED":
      return d || "NotPanel didn't accept this key. Check that you copied all of it and that the key is active.";
    case "NOTPANEL_REQUIRED":
      return "Add a NotPanel API key first.";
    case "SETUP_DONE":
      return "Setup is already finished. Open your bot in Telegram and use the admin panel (Profile, then Admin).";
    case "INVALID_SETUP_TOKEN":
      return "Your setup session expired. Enter the bot token again.";
    case "STEP_FAILED":
      return `This step failed${d ? `: ${d}` : ""}. Try again.`;
  }
  if (e.status === 429) return "Too many wrong tokens from this network. Try again in an hour.";
  if (where === "token" && (e.status === 400 || e.status === 403)) return "That token doesn't match this app's bot. Copy it again from @BotFather (it looks like 123456789:AAH...).";
  if (e.status === 401) return "Your setup session expired. Enter the bot token again.";
  if (where === "run") return `This step failed (${e.code}). Try again.`;
  return `Something went wrong (${e.code}).`;
}

const isExpired = (e: unknown) => e instanceof ApiError && (e.code === "INVALID_SETUP_TOKEN" || e.status === 401);
const isDone = (e: unknown) => e instanceof ApiError && e.code === "SETUP_DONE";

function getToken(): string {
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}
function saveToken(v: string) {
  try {
    if (v) sessionStorage.setItem(TOKEN_KEY, v);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* kept in memory only */
  }
}

export function PublicPages() {
  const [pub, setPub] = useState<PublicStatus | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = () => {
    setError(null);
    api<PublicStatus>("/public").then(
      (p) => {
        applyBrand(p.brand);
        setPub(p);
      },
      setError,
    );
  };
  useEffect(load, []);

  if (error)
    return (
      <Screen bottom="none" center>
        <ErrorState error={error} onRetry={load} />
      </Screen>
    );
  if (!pub)
    return (
      <Screen bottom="none">
        <Skeleton h={120} radius={24} />
        <Skeleton h={50} />
      </Screen>
    );
  return pub.configured ? <OpenInTelegram bot={pub.botUsername} /> : <Setup initialBot={pub.botUsername} />;
}

function OpenInTelegram({ bot }: { bot: string | null }) {
  const brand = brandStore.use();
  return (
    <Screen bottom="none" center class="onboard">
      <div class="setup-mark rise">
        <BrandMark size={88} />
      </div>
      <LargeTitle align="center" size="title" title={brand.name} sub="This app runs inside Telegram." />
      {bot ? (
        <a class="btn" href={`https://t.me/${bot}`} rel="noopener">
          Open @{bot} in Telegram
        </a>
      ) : (
        <Notice tone="plain">Open the bot in Telegram to use this app.</Notice>
      )}
    </Screen>
  );
}

// ---------- setup wizard ----------

const CLAIM_KEY = "np_setup_claim";
function getClaim(): string | null {
  try {
    return sessionStorage.getItem(CLAIM_KEY);
  } catch {
    return null;
  }
}
function saveClaim(v: string | null) {
  try {
    if (v) sessionStorage.setItem(CLAIM_KEY, v);
    else sessionStorage.removeItem(CLAIM_KEY);
  } catch {
    /* kept in memory only */
  }
}

function Setup({ initialBot }: { initialBot: string | null }) {
  const [token, setToken] = useState(getToken());
  const [status, setStatusRaw] = useState<SetupStatus | null>(null);
  // The server returns the claim link only from unlock and from the last setup step, never from status: keep it here.
  const [claimLink, setClaimLink] = useState<string | null>(getClaim());
  const [done, setDone] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const setStatus = (s: SetupStatus) => {
    if (s.claimLink) {
      saveClaim(s.claimLink);
      setClaimLink(s.claimLink);
    }
    setStatusRaw(s);
  };

  // `x-setup-token` on every call; "setup is finished" (an admin exists) always leads to the done screen
  const call: Call = async <T,>(path: string, body?: unknown): Promise<T> => {
    try {
      return await api<T>(path, { method: body === undefined ? "GET" : "POST", body, headers: { "x-setup-token": token } });
    } catch (e) {
      if (isDone(e)) setDone(true);
      throw e;
    }
  };

  const expire = (msg: string) => {
    saveToken("");
    setToken("");
    setStatusRaw(null);
    setNotice(msg);
  };
  const expired = () => expire("Your setup session expired. Enter the bot token again.");

  // A saved session (page reload): pick up where we were
  useEffect(() => {
    if (!token || status) return;
    call<SetupStatus>("/setup/status").then(setStatus, (e) => {
      if (!isDone(e)) expire(problem(e));
    });
  }, [token]);

  if (done) return <Done bot={status?.botUsername ?? initialBot} />;
  if (!token)
    return (
      <TokenStep
        notice={notice}
        onUnlocked={(t, s) => {
          saveToken(t);
          setNotice(null);
          setToken(t);
          setStatus(s);
        }}
      />
    );
  if (!status)
    return (
      <Screen bottom="none">
        <Skeleton h={80} />
        <Skeleton h={50} />
      </Screen>
    );
  if (!status.notpanelOk) return <KeyStep status={status} call={call} onStatus={setStatus} onExpired={expired} />;
  if (status.pending.length) return <RunStep status={status} call={call} onStatus={setStatus} onExpired={expired} />;
  return <ClaimStep status={status} claimLink={claimLink} call={call} onStatus={setStatus} onDone={() => setDone(true)} onExpired={expired} onRestart={() => expire("Enter the bot token again to get a new admin link.")} />;
}

type Call = <T>(path: string, body?: unknown) => Promise<T>;

function Hero({ step, title, sub }: { step: number; title: string; sub: string }) {
  return (
    <>
      <FlowSteps step={step} total={4} />
      <LargeTitle size="title" title={title} sub={sub} />
    </>
  );
}

function TokenStep({ notice, onUnlocked }: { notice: string | null; onUnlocked: (token: string, status: SetupStatus) => void }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(notice);
  const shaped = /^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(value.trim());

  const submit = async (e?: Event) => {
    e?.preventDefault();
    if (busy) return;
    if (!shaped) {
      setErr("That doesn't look like a bot token. It looks like 123456789:AAH... and comes from @BotFather.");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ token: string; status: SetupStatus }>("/setup/unlock", { body: { botToken: value.trim() } });
      setValue("");
      onUnlocked(r.token, r.status);
    } catch (e) {
      setErr(problem(e, "token"));
      setBusy(false);
    }
  };

  return (
    <Screen bottom="none" class="onboard">
      <Hero step={1} title="Set up your bot" sub="This takes about two minutes. First, prove this is your bot." />
      <form class="setup-form" onSubmit={submit}>
        <div class="card pad setup-how">
          <ol>
            <li>
              Open <b>@BotFather</b> in Telegram.
            </li>
            <li>
              Send <code class="mono">/mybots</code>, pick your bot, then <b>API Token</b>.
            </li>
            <li>Copy the token and paste it below.</li>
          </ol>
        </div>
        <Field
          id="setup-token"
          label="Bot token"
          type="password"
          lead="shield"
          value={value}
          onInput={(v) => (setValue(v), setErr(null))}
          placeholder="123456789:AAH..."
          error={err}
          help="It must match the token you gave this deployment. It is only compared on the server, never stored."
          enterKeyHint="go"
          dir="ltr"
        />
        <button type="submit" class="btn" disabled={busy || !value.trim()} aria-busy={busy ? "true" : undefined}>
          {busy ? <span class="spin" aria-hidden="true" /> : null}
          Continue
        </button>
      </form>
    </Screen>
  );
}

function KeyStep({ status, call, onStatus, onExpired }: { status: SetupStatus; call: Call; onStatus: (s: SetupStatus) => void; onExpired: () => void }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (e?: Event) => {
    e?.preventDefault();
    if (busy) return;
    const key = value.trim();
    if (!looksLikeNotPanelKey(key)) {
      setErr("This isn't a NotPanel API key. NotPanel keys start with np_live_. Copy it again from your notpanel.com account.");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      onStatus(await call<SetupStatus>("/setup/notpanel-key", { key }));
      setValue("");
    } catch (e) {
      if (isExpired(e)) return onExpired();
      setErr(problem(e, "key"));
      setBusy(false);
    }
  };

  return (
    <Screen bottom="none" class="onboard">
      <Hero step={2} title="Connect NotPanel" sub={status.botUsername ? `@${status.botUsername} is verified. Next, the account that fulfils your orders.` : "Next, the account that fulfils your orders."} />
      {status.notpanelError ? <Notice tone="warn">{status.notpanelError}</Notice> : null}
      <form class="setup-form" onSubmit={submit}>
        <div class="card pad setup-how">
          <ol>
            <li>
              Create a free account on{" "}
              <a href="https://notpanel.com" target="_blank" rel="noopener">
                notpanel.com
              </a>
              .
            </li>
            <li>Open the API section and create an API key.</li>
            <li>Paste the key below. You can change it later in the admin panel.</li>
          </ol>
        </div>
        <Field id="setup-key" label="NotPanel API key" type="password" lead="plug" value={value} onInput={(v) => (setValue(v), setErr(null))} placeholder="np_live_..." error={err} help="Only NotPanel keys work here." enterKeyHint="go" dir="ltr" />
        <button type="submit" class="btn" disabled={busy || !value.trim()} aria-busy={busy ? "true" : undefined}>
          {busy ? <span class="spin" aria-hidden="true" /> : null}
          Check and save key
        </button>
      </form>
    </Screen>
  );
}

function RunStep({ status, call, onStatus, onExpired }: { status: SetupStatus; call: Call; onStatus: (s: SetupStatus) => void; onExpired: () => void }) {
  const [running, setRunning] = useState<SetupStep | null>(null);
  const [failed, setFailed] = useState<{ step: SetupStep; msg: string } | null>(null);
  const live = useRef(true);
  const inFlight = useRef(false);
  useEffect(() => () => void (live.current = false), []);

  const next = status.pending[0];
  const run = async (step: SetupStep) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setRunning(step);
    setFailed(null);
    try {
      const s = await call<SetupStatus>("/setup/run", { step });
      if (live.current) onStatus(s);
    } catch (e) {
      if (!live.current) return;
      if (isExpired(e)) return onExpired();
      if (e instanceof ApiError && e.code === "NOTPANEL_REQUIRED") return void onStatus({ ...status, notpanelOk: false });
      setFailed({ step, msg: problem(e, "run") });
    } finally {
      inFlight.current = false;
      if (live.current) setRunning(null);
    }
  };

  // Runs the pending steps one after another; stops at the first failure until the owner taps Try again.
  useEffect(() => {
    if (next && !failed && !running) void run(next);
  }, [next, failed, running]);

  const stateOf = (s: SetupStep) => (failed?.step === s ? "failed" : running === s ? "running" : status.pending.includes(s) ? "waiting" : "done");
  return (
    <Screen bottom="none" class="onboard">
      <Hero step={3} title="Setting up your bot" sub="Connecting Telegram and writing your bot's texts. Keep this page open." />
      <Section>
        <List>
          {STEP_ORDER.map((s) => {
            const st = stateOf(s);
            return (
              <Row
                key={s}
                lead={
                  <span class={`tile sm run-${st}`} aria-hidden="true">
                    {st === "running" ? <span class="spin" /> : st === "done" ? <Icon name="check" size={18} stroke={2.4} /> : st === "failed" ? <Icon name="alert" size={18} stroke={2} /> : <Icon name="clock" size={18} stroke={1.8} />}
                  </span>
                }
                title={STEP_LABEL[s][0]}
                meta={st === "failed" ? failed!.msg : STEP_LABEL[s][1]}
                value={<span class="sr">{st}</span>}
                wrap
              />
            );
          })}
        </List>
      </Section>
      {failed ? (
        <button type="button" class="btn" onClick={() => void run(failed.step)}>
          Try again
        </button>
      ) : null}
    </Screen>
  );
}

function ClaimStep({
  status,
  claimLink,
  call,
  onStatus,
  onDone,
  onExpired,
  onRestart,
}: {
  status: SetupStatus;
  claimLink: string | null;
  call: Call;
  onStatus: (s: SetupStatus) => void;
  onDone: () => void;
  onExpired: () => void;
  onRestart: () => void;
}) {
  const [opened, setOpened] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (status.ownerReady) return onDone();
    let live = true;
    const id = setInterval(async () => {
      try {
        const s = await call<SetupStatus>("/setup/status");
        if (!live) return;
        onStatus(s);
        setErr(null);
      } catch (e) {
        if (!live) return;
        if (isDone(e)) onDone();
        else if (isExpired(e)) onExpired();
        else setErr(problem(e));
      }
    }, 3000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [status.ownerReady]);

  return (
    <Screen bottom="none" class="onboard">
      <Hero step={4} title="Become the admin" sub="The first person to use the link below becomes the admin of this bot." />
      {claimLink ? (
        <>
          <a class="btn" href={claimLink} target="_blank" rel="noopener" onClick={() => setOpened(true)}>
            <Icon name="plane" size={20} stroke={1.9} />
            Open in Telegram
          </a>
          <div class="card pad setup-how">
            <ol>
              <li>Tap the button. Telegram opens your bot with a code.</li>
              <li>
                Press <b>Start</b> in the chat.
              </li>
              <li>Come back to this page. It continues by itself.</li>
            </ol>
          </div>
          {opened ? (
            <p class="note setup-wait">
              <span class="spin" aria-hidden="true" /> Waiting for you to press Start...
            </p>
          ) : null}
          <p class="note">The link works once and expires after an hour. If it stops working, enter the bot token again to get a new one.</p>
        </>
      ) : (
        <>
          <Notice tone="warn">The admin link isn't available any more (it is only shown right after setup). Enter the bot token again to get a new one.</Notice>
          <button type="button" class="btn" onClick={onRestart}>
            Get a new link
          </button>
        </>
      )}
      {err ? <Notice tone="error">{err}</Notice> : null}
    </Screen>
  );
}

function Done({ bot }: { bot: string | null }) {
  const brand = brandStore.use();
  useEffect(() => (saveToken(""), saveClaim(null)), []);
  return (
    <Screen bottom="none" center class="onboard">
      <div class="setup-mark rise">
        <BrandMark size={88} />
      </div>
      <LargeTitle align="center" size="title" title="You're all set" sub={`${brand.name} is live. Open the bot and tap the menu button to try it.`} />
      {bot ? (
        <a class="btn" href={`https://t.me/${bot}`} rel="noopener">
          Open @{bot}
        </a>
      ) : null}
      <p class="note">
        Customize the name, logo and colors in the app under Profile, then Admin, then Branding.
      </p>
    </Screen>
  );
}
