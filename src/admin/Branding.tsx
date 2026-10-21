// Admin > Branding: name, logo, welcome banner, colors (with live preview), links, welcome text and custom emoji.
// English only, like the rest of the admin panel.
import { useEffect, useRef, useState } from "preact/hooks";
import {
  LIMITS,
  THEME_PRESETS,
  validBrandName,
  validButtonIcons,
  validCustomEmojiMap,
  validHexColor,
  validHttpsUrl,
  type BrandInfo,
  type ButtonIcons,
} from "../../shared/brand";
import { themeFor } from "../../shared/theme";
import { api, ApiError } from "../api";
import { Icon } from "../icons";
import { refreshMe } from "../me";
import { meStore } from "../store";
import { confirmDialog } from "../tg";
import { applyBrand, brandStore, previewColors } from "../theme";
import { BrandMark, ErrorState, Field, List, Notice, Row, Section, SkeletonList, toast, useAsync } from "../ui";
import { Page, fail } from "./AdminRoutes";

interface BrandingSettings {
  brand_name: string;
  brand_preset: string;
  brand_accent: string;
  website_url: string;
  terms_url: string;
  welcome_text: string;
  custom_emoji: string;
  button_icons: string;
}

/** The server may send the two JSON settings as objects or as JSON strings; the page works with strings. */
async function loadSettings(): Promise<BrandingSettings> {
  const r = await api<Record<string, unknown> & BrandingSettings>("/admin/settings");
  const str = (v: unknown, empty: string) => (typeof v === "string" ? v : v && typeof v === "object" ? JSON.stringify(v) : empty);
  return { ...r, custom_emoji: str(r.custom_emoji, "{}"), button_icons: str(r.button_icons, "{}") };
}

const ICON_FIELDS: [keyof ButtonIcons, string][] = [
  ["open", "Open the app"],
  ["viewOrder", "View order"],
  ["terms", "Terms"],
  ["invite", "Invite friends"],
];
const EMPTY_ICONS: ButtonIcons = { open: "", viewOrder: "", terms: "", invite: "" };

function parseIcons(raw: string): ButtonIcons {
  try {
    const v = JSON.parse(raw || "{}");
    return validButtonIcons({ ...EMPTY_ICONS, ...v }) ? { ...EMPTY_ICONS, ...v } : EMPTY_ICONS;
  } catch {
    return EMPTY_ICONS;
  }
}

/** Pretty JSON for the emoji box ("{}" shows as empty). */
function emojiText(raw: string): string {
  try {
    const v = JSON.parse(raw || "{}");
    return Object.keys(v).length ? JSON.stringify(v, null, 2) : "";
  } catch {
    return raw;
  }
}

/** Parsed emoji map, or a plain-words problem. */
function parseEmoji(text: string): { value: Record<string, string> } | { problem: string } {
  const t = text.trim();
  if (!t) return { value: {} };
  let v: unknown;
  try {
    v = JSON.parse(t);
  } catch {
    return { problem: 'This isn\'t valid JSON. Use the form {"🚀": "5368324170671202286"} with straight double quotes.' };
  }
  if (!validCustomEmojiMap(v))
    return { problem: `Each entry must be one emoji (up to 8 characters) mapped to a numeric custom emoji ID of 10 to 25 digits, with at most ${LIMITS.customEmoji} entries.` };
  return { value: v };
}

/** What's wrong with a branding value, in plain words (same rules as the server), or null. */
function problemOf(key: keyof BrandingSettings, v: BrandingSettings, icons: ButtonIcons, emoji: string): string | null {
  switch (key) {
    case "brand_name":
      return !v.brand_name || validBrandName(v.brand_name) ? null : `The name can be 1 to ${LIMITS.brandName} characters, with no line breaks.`;
    case "brand_accent":
      return validHexColor(v.brand_accent) ? null : "The color must look like #2457ff (a # and six letters or digits).";
    case "website_url":
      return !v.website_url || validHttpsUrl(v.website_url) ? null : "The website link must start with https:// and be a real address.";
    case "terms_url":
      return !v.terms_url || validHttpsUrl(v.terms_url) ? null : "The terms link must start with https:// and be a real address.";
    case "welcome_text":
      return v.welcome_text.length <= LIMITS.welcomeText ? null : `The welcome text can be up to ${LIMITS.welcomeText} characters.`;
    case "custom_emoji": {
      const r = parseEmoji(emoji);
      return "problem" in r ? r.problem : null;
    }
    case "button_icons":
      return validButtonIcons(icons) ? null : "Button icon IDs must be numbers of 10 to 25 digits, or empty.";
    default:
      return null;
  }
}

function Swatch({ label, color, on, onClick, custom }: { label: string; color?: string; on: boolean; onClick: () => void; custom?: boolean }) {
  return (
    <button type="button" class="ptile" aria-pressed={on} aria-label={`${label} color`} onClick={onClick}>
      <span class={on ? "logo on" : "logo"} style={custom ? "background:conic-gradient(#e0531f,#f2a900,#0f8a5f,#0a6fd6,#6d3cf5,#d61f69,#e0531f);border-color:transparent" : `background:${color};border-color:transparent`}>
        {on ? <Icon name="check" size={22} stroke={2.6} class="swatch-check" /> : null}
      </span>
      <span>{label}</span>
    </button>
  );
}

function ImagePicker({
  kind,
  title,
  help,
  preview,
  has,
  onChanged,
}: {
  kind: "logo" | "banner";
  title: string;
  help: string;
  preview: preact.ComponentChildren;
  has: boolean;
  onChanged: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const pick = async (file: File | undefined) => {
    if (!file) return;
    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) return void toast("Use a PNG, JPEG or WebP image.", "error");
    if (file.size > LIMITS.imageBytes) return void toast(`That image is ${Math.round(file.size / 1000)} KB. The limit is ${Math.round(LIMITS.imageBytes / 1000)} KB.`, "error");
    setBusy(true);
    try {
      await api(`/admin/assets/${kind}`, { method: "PUT", body: file });
      toast(`${title} updated`, "ok");
      onChanged();
    } catch (e) {
      fail(e);
    }
    setBusy(false);
    if (input.current) input.current.value = "";
  };
  const remove = async () => {
    setBusy(true);
    try {
      await api(`/admin/assets/${kind}`, { method: "DELETE" });
      toast(`${title} removed`, "ok");
      onChanged();
    } catch (e) {
      fail(e);
    }
    setBusy(false);
  };
  return (
    <Section header={title} footer={help}>
      <div class="card pad brand-pick">
        {preview}
        <div class="brand-pick-acts">
          <input ref={input} id={`pick-${kind}`} class="sr" type="file" accept="image/png,image/jpeg,image/webp" onChange={(e) => pick(e.currentTarget.files?.[0])} disabled={busy} />
          <label class="btn sm soft inline" for={`pick-${kind}`}>
            {busy ? <span class="spin" aria-hidden="true" /> : null}
            {has ? "Replace" : "Upload"}
          </label>
          {has ? (
            <button type="button" class="btn sm danger inline" onClick={remove} disabled={busy}>
              Remove
            </button>
          ) : null}
        </div>
      </div>
    </Section>
  );
}

export function AdminBranding() {
  const res = useAsync(loadSettings, []);
  const me = meStore.use()!;
  const brand = brandStore.use();
  const saved: BrandInfo = me.brand;
  const [draft, setDraft] = useState<Partial<BrandingSettings>>({});
  const [icons, setIcons] = useState<ButtonIcons | null>(null);
  const [emoji, setEmoji] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [assetKey, setAssetKey] = useState(() => Date.now());
  const [bannerOk, setBannerOk] = useState(true);

  const base = res.data;
  const s = base ? { ...base, ...draft } : null;
  const iconsNow = icons ?? (base ? parseIcons(base.button_icons) : EMPTY_ICONS);
  const emojiNow = emoji ?? (base ? emojiText(base.custom_emoji) : "");
  const iconsDirty = !!base && JSON.stringify(iconsNow) !== JSON.stringify(parseIcons(base.button_icons));
  const emojiDirty = !!base && emoji !== null && emojiNow.trim() !== emojiText(base.custom_emoji).trim();
  const dirty = !!base && ((Object.keys(draft) as (keyof BrandingSettings)[]).some((k) => draft[k] !== base[k]) || iconsDirty || emojiDirty);

  const set = <K extends keyof BrandingSettings>(k: K, v: BrandingSettings[K]) => setDraft((d) => ({ ...d, [k]: v }));

  // Live preview: the whole app takes the colors while editing; leaving the page puts the saved ones back.
  const preset = s?.brand_preset ?? saved.preset;
  const accent = s?.brand_accent ?? saved.accent;
  useEffect(() => {
    if (!s) return;
    if (preset === "custom" && !validHexColor(accent)) return;
    previewColors(saved, preset, accent);
  }, [preset, accent, !!s]);
  useEffect(() => () => applyBrand(meStore.get()?.brand ?? saved), []);

  const problems: Partial<Record<keyof BrandingSettings, string | null>> = s
    ? {
        brand_name: problemOf("brand_name", s, iconsNow, emojiNow),
        brand_accent: preset === "custom" ? problemOf("brand_accent", s, iconsNow, emojiNow) : null,
        website_url: problemOf("website_url", s, iconsNow, emojiNow),
        terms_url: problemOf("terms_url", s, iconsNow, emojiNow),
        welcome_text: problemOf("welcome_text", s, iconsNow, emojiNow),
        custom_emoji: emojiDirty ? problemOf("custom_emoji", s, iconsNow, emojiNow) : null,
        button_icons: iconsDirty ? problemOf("button_icons", s, iconsNow, emojiNow) : null,
      }
    : {};

  const save = async () => {
    if (!base || !s) return;
    const bad = (Object.keys(problems) as (keyof BrandingSettings)[]).find((k) => problems[k]);
    if (bad) return void toast(problems[bad]!, "error");
    const body: Record<string, string> = {};
    for (const k of Object.keys(draft) as (keyof BrandingSettings)[]) if (draft[k] !== base[k]) body[k] = draft[k]!;
    if (emojiDirty) {
      const r = parseEmoji(emojiNow);
      if ("value" in r) body.custom_emoji = JSON.stringify(r.value);
    }
    if (iconsDirty) body.button_icons = JSON.stringify(iconsNow);
    setBusy(true);
    try {
      await api("/admin/settings", { method: "PUT", body });
      setDraft({});
      setIcons(null);
      setEmoji(null);
      await refreshMe().catch(() => undefined);
      toast("Branding saved", "ok");
      res.reload();
    } catch (e) {
      const key = e instanceof ApiError && e.code === "INVALID_VALUE" ? (String(e.details?.key ?? "") as keyof BrandingSettings) : null;
      const why = key && s ? problemOf(key, s, iconsNow, emojiNow) : null;
      if (key) toast(why ?? `That value isn't allowed (${key}).`, "error");
      else fail(e);
    }
    setBusy(false);
  };

  const [syncing, setSyncing] = useState(false);
  const syncBot = async () => {
    if (syncing) return;
    const ok = await confirmDialog(
      "This sets the bot's name to your brand name + \"SMM Panel\" (translated) in all 76 languages, and replaces any name you set in @BotFather. Continue?",
      "Update",
      "Cancel",
    );
    if (!ok) return;
    setSyncing(true);
    try {
      // Name, About text, description and commands in every language, in batches (same as "Reconnect" in Settings)
      for (let batch: number | null = 0; batch !== null; ) batch = (await api<{ next: number | null }>(`/admin/bot-texts/${batch}`, { method: "POST" })).next;
      toast("Bot name and description updated in Telegram", "ok");
    } catch (e) {
      fail(e);
    }
    setSyncing(false);
  };

  const assetChanged = () => {
    setAssetKey(Date.now());
    setBannerOk(true);
    void refreshMe().catch(() => undefined);
  };
  const theme = themeFor({ preset, accent: validHexColor(accent) ? accent : saved.accent });
  const presetAccent = THEME_PRESETS.find((p) => p.id === preset)?.accent;

  return (
    <Page back="/admin" title="Branding" sub="Your name, logo and colors, shown everywhere" main={dirty ? { text: "Save", onClick: save, progress: busy } : null}>
      {!s ? (
        res.error ? (
          <ErrorState error={res.error} onRetry={res.reload} />
        ) : (
          <>
            <SkeletonList rows={3} lead="none" />
            <SkeletonList rows={4} lead="none" />
          </>
        )
      ) : (
        <>
          <Field
            id="brand-name"
            label="Name"
            value={s.brand_name}
            onInput={(v) => set("brand_name", v)}
            placeholder={brand.name}
            maxLength={LIMITS.brandName}
            error={problems.brand_name}
            help="Shown in the app, in bot messages and in the browser tab. Leave empty to use your bot's name."
          />

          <ImagePicker
            kind="logo"
            title="Logo"
            help="PNG, JPEG or WebP, up to 700 KB. A square picture works best: it is shown in a circle. Without a logo, the first letter of your name is used."
            has={!!saved.logoUrl}
            onChanged={assetChanged}
            preview={<BrandMark size={72} />}
          />

          <ImagePicker
            kind="banner"
            title="Welcome banner"
            help="The picture above the welcome message in the bot. 1200 × 900 pixels (4:3) is ideal. PNG, JPEG or WebP, up to 700 KB."
            has={bannerOk}
            onChanged={assetChanged}
            preview={
              <div class="brand-banner" aria-hidden={bannerOk ? undefined : "true"}>
                {bannerOk ? <img src={`/media/banner?v=${assetKey}`} alt="Welcome banner preview" onError={() => setBannerOk(false)} /> : <span class="hint">No banner</span>}
              </div>
            }
          />

          <Section header="Bot profile in Telegram" footer="Saving a new name changes the app and bot messages right away. To also change the bot's name, About text and description in Telegram (in all 10 languages), tap this after saving. Telegram limits how often a bot's name can change.">
            <List>
              <Row accent title={syncing ? "Updating Telegram…" : "Update bot name & description in Telegram"} onClick={syncBot} disabled={syncing || dirty} meta={dirty ? "Save your changes first" : undefined} chevron={false} />
            </List>
          </Section>

          <Section header="Color" footer="Changes show up in the whole app while you edit. They are saved only when you tap Save.">
            <div class="card">
              <div class="grid5" role="group" aria-label="Color theme">
                {THEME_PRESETS.map((p) => (
                  <Swatch key={p.id} label={p.label} color={p.accent} on={preset === p.id} onClick={() => (set("brand_preset", p.id), set("brand_accent", p.accent))} />
                ))}
                <Swatch label="Custom" custom on={preset === "custom"} onClick={() => (set("brand_preset", "custom"), set("brand_accent", validHexColor(accent) ? accent : (presetAccent ?? saved.accent)))} />
              </div>
            </div>
            {preset === "custom" ? (
              <Field
                id="brand-accent"
                label="Custom color"
                value={s.brand_accent}
                onInput={(v) => set("brand_accent", v.startsWith("#") || !v ? v : `#${v}`)}
                placeholder="#2457ff"
                maxLength={7}
                dir="ltr"
                error={problems.brand_accent}
                trailing={
                  <input
                    type="color"
                    class="color-pick"
                    aria-label="Pick a color"
                    value={validHexColor(s.brand_accent) ? s.brand_accent : "#2457ff"}
                    onInput={(e) => set("brand_accent", e.currentTarget.value)}
                  />
                }
              />
            ) : null}
            {theme.light["--on-brand"] === "#000000" || theme.dark["--on-brand"] === "#000000" ? (
              <Notice tone="plain">This color is light, so buttons use dark text to stay readable.</Notice>
            ) : null}
          </Section>

          <Section header="Links" footer="Both are optional. The website appears as a tile in Profile. If you leave the terms link empty, the terms text from Settings is shown inside the app.">
            <Field id="brand-web" label="Website" type="url" inputMode="url" dir="ltr" value={s.website_url} onInput={(v) => set("website_url", v.trim())} placeholder="https://example.com" error={problems.website_url} />
            <Field id="brand-terms" label="Terms of service link" type="url" inputMode="url" dir="ltr" value={s.terms_url} onInput={(v) => set("terms_url", v.trim())} placeholder="https://example.com/terms" error={problems.terms_url} />
          </Section>

          <Field
            id="brand-welcome"
            label="Welcome message"
            multiline
            rows={5}
            value={s.welcome_text}
            maxLength={LIMITS.welcomeText}
            onInput={(v) => set("welcome_text", v)}
            error={problems.welcome_text}
            help={
              <>
                Sent when someone starts the bot. Type <code class="mono">{"{name}"}</code> where the customer's first name should go. Leave empty to use the built-in message, which is translated into every language; a custom text is sent as written, in one language.
              </>
            }
          />

          <Section header="Premium emoji (optional)" footer="Needs Telegram Premium on the account that owns the bot. IDs come from custom emoji sticker packs (for example via @RawDataBot).">
            <Field
              id="brand-emoji"
              label="Emoji replacements"
              multiline
              rows={5}
              value={emojiNow}
              onInput={(v) => setEmoji(v)}
              placeholder={'{\n  "🚀": "5368324170671202286"\n}'}
              dir="ltr"
              error={problems.custom_emoji}
              help="Each plain emoji in bot messages is swapped for its animated custom emoji. JSON: emoji, then ID."
            />
          </Section>

          <Section header="Button icons (optional)" footer="Custom emoji IDs shown on the bot's inline buttons. Leave a field empty for no icon.">
            <div class="card">
              {ICON_FIELDS.map(([k, label]) => (
                <div class="kv" key={k}>
                  <dt>
                    <label for={`icon-${k}`}>{label}</label>
                  </dt>
                  <dd>
                    <input
                      id={`icon-${k}`}
                      dir="ltr"
                      inputMode="numeric"
                      autoComplete="off"
                      size={18}
                      placeholder="No icon"
                      value={iconsNow[k]}
                      onInput={(e) => setIcons({ ...iconsNow, [k]: e.currentTarget.value.replace(/\D/g, "") })}
                    />
                  </dd>
                </div>
              ))}
            </div>
            {problems.button_icons ? (
              <p class="field-error" role="alert">
                <Icon name="alert" size={15} stroke={2.2} />
                <span>{problems.button_icons}</span>
              </p>
            ) : null}
          </Section>
        </>
      )}
    </Page>
  );
}
