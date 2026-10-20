// Inline-SVG artwork (design spec §8): NotPanel stickers. Pastel plates, 1.5px ink outlines, flat offset shadows;
// no gradients, filters or masks. Motion comes from styles.css: `.enter` on the <svg> (A1–A3, once) or `.celebrate`
// on the `.success-art` wrapper (A4, A5) animates the a-* groups below. An animated <g> never carries its own
// transform attribute (§7.8), so positioned content always sits one <g> deeper.
import type { ComponentChildren, JSX } from "preact";
import { useEffect, useState } from "preact/hooks";
import { t } from "./i18n";
import { ICON_PATHS, type IconName } from "./icons";
import { brandStore } from "./theme";
import { monogram } from "../shared/theme";
import { BrandMark, Chip, EmptyState, LargeTitle, Screen, Section, registerEmptyArt, type ArtName } from "./ui";

const PAPER = "var(--art-paper)";
const LIME = "var(--lime)";
const PINK = "var(--pink)";
const SKY = "var(--sky)";
const LAVS = "var(--lavender-strong)";
const CREAM = "var(--cream)";
const COBALT = "var(--brand)"; // the accent (name kept from the original cobalt design)
const INK = "var(--ink)";
const SHADOW = "var(--art-shadow)";
const SHADOW_BRAND = "var(--art-shadow-brand)";

const isRtl = () => typeof document !== "undefined" && document.documentElement.dir === "rtl";

// ---------- primitives (§8.1) ----------

/** Sticker start pose for a-stk (--fx/--fy/--fr) and its delay (--d). */
type Motion = { d?: number; fx?: number; fy?: number; fr?: number };
const vars = ({ d, fx, fy, fr }: Motion) =>
  [d != null && `--d:${d}ms`, fx && `--fx:${fx}px`, fy != null && `--fy:${fy}px`, fr != null && `--fr:${fr}deg`].filter(Boolean).join(";");

function Frame({ vw, vh, cls, children }: { vw: number; vh: number; cls?: string; children: ComponentChildren }) {
  return (
    <svg class={cls ? `art ${cls}` : "art"} viewBox={`0 0 ${vw} ${vh}`} width={vw} height={vh} aria-hidden="true" focusable="false" overflow="visible">
      {children}
    </svg>
  );
}

type CardP = { x: number; y: number; w: number; h?: number; r: number; rot?: number; fill: string; shadow?: string; cls?: string; m?: Motion; children?: ComponentChildren };

/** Rounded plate with ink outline. The flat shadow is offset (3, 5) in page space, so every sticker shares one light. */
function Card({ x, y, w, h = w, r, rot = 0, fill, shadow = SHADOW, cls, m, children }: CardP) {
  const turn = `rotate(${rot} ${w / 2} ${h / 2})`;
  return (
    <g class={cls ?? (m ? "a-stk" : undefined)} style={m && vars(m)}>
      <rect width={w} height={h} rx={r} transform={`translate(${x + 3} ${y + 5}) ${turn}`} style={`fill:${shadow}`} />
      <g transform={`translate(${x} ${y}) ${turn}`}>
        <rect width={w} height={h} rx={r} class="ink" style={`fill:${fill}`} />
        {children}
      </g>
    </g>
  );
}

type GlyphP = { name: IconName; cx: number; cy: number; size: number; stroke?: number; color?: string; fill?: string };

/** A 24×24 icon path placed by its centre. The heart is nudged up so it looks centred (its box sits low in the grid). */
function Glyph({ name, cx, cy, size, stroke = 1.8, color = INK, fill = "none" }: GlyphP) {
  const k = size / 24;
  const dy = name === "heart" ? -1.3 * k : 0;
  return (
    <path
      d={ICON_PATHS[name]}
      transform={`translate(${cx - size / 2} ${cy - size / 2 + dy}) scale(${k})`}
      vector-effect="non-scaling-stroke"
      stroke-linecap="round"
      stroke-linejoin="round"
      style={`fill:${fill};stroke:${color};stroke-width:${stroke}px`}
    />
  );
}

const heart = (cx: number, cy: number, size: number) => <Glyph name="heart" cx={cx} cy={cy} size={size} color="none" fill={COBALT} />;
const star = (cx: number, cy: number, size: number) => <Glyph name="star" cx={cx} cy={cy} size={size} stroke={1} color="var(--star-stroke)" fill="var(--star)" />;

/** Four-point sparkle, `s` wide. Fades in under .enter/.celebrate. */
function Spark({ cx, cy, s, fill, ink, o, d }: { cx: number; cy: number; s: number; fill: string; ink?: boolean; o?: number; d?: number }) {
  const k = s / 14; // the spark path spans 14 units around (12, 10)
  return (
    <path
      class={ink ? "ink a-fade" : "a-fade"}
      d={ICON_PATHS.spark}
      transform={`translate(${cx - 12 * k} ${cy - 10 * k}) scale(${k})`}
      opacity={o}
      style={`fill:${fill}${ink ? ";stroke-width:1px" : ""}${d != null ? `;--d:${d}ms` : ""}`}
    />
  );
}

const Logo = ({ slug, c, size }: { slug: string; c: number; size: number }) => (
  <image href={`/platforms/${slug}.svg`} x={c - size / 2} y={c - size / 2} width={size} height={size} />
);

const Disc = ({ cx, cy, r }: { cx: number; cy: number; r: number }) => <circle class="disc a-disc" cx={cx} cy={cy} r={r} />;
const Ring = ({ cx, cy, r }: { cx: number; cy: number; r: number }) => <circle class="ring a-fade" cx={cx} cy={cy} r={r} />;

/** Dashed white ring on cobalt cards (A1, A10); the card clips it. */
const BrandRing = ({ cx, cy, r, a }: { cx: number; cy: number; r: number; a: number }) => (
  <circle class="a-fade" cx={cx} cy={cy} r={r} fill="none" style={`stroke:var(--on-brand);stroke-opacity:${a}`} stroke-width="2" stroke-dasharray="6 7" vector-effect="non-scaling-stroke" />
);

/** Star coin with its flat shadow. */
function Coin({ cx, cy, r, star: s, shadow = SHADOW }: { cx: number; cy: number; r: number; star: number; shadow?: string }) {
  return (
    <>
      <circle cx={cx + 3} cy={cy + 5} r={r} style={`fill:${shadow}`} />
      <circle cx={cx} cy={cy} r={r} class="ink" style={`fill:${CREAM}`} />
      {star(cx, cy, s)}
    </>
  );
}

/** Edge-anchored art (A1, A10) mirrors positions in RTL, never glyphs or logos: x' = vw - x - w, rot' = -rot. */
function mirror(vw: number) {
  const f = isRtl() ? -1 : 1;
  return { f, x: (x: number, w = 0) => (f < 0 ? vw - x - w : x) };
}

// ---------- A1 Home hero (160×108, top end of the cobalt hero card) ----------

export function ArtHomeHero({ enter }: { enter?: boolean }) {
  const { f, x } = mirror(160);
  return (
    <Frame vw={160} vh={108} cls={enter ? "enter" : undefined}>
      <BrandRing cx={x(132)} cy={16} r={92} a={0.28} />
      <circle class="a-fade" cx={x(128)} cy={20} r={64} style="fill:var(--ob-10)" />
      <Spark cx={x(34)} cy={18} s={12} fill="var(--on-brand)" o={0.85} />
      <Card x={x(58, 40)} y={12} w={40} r={12} rot={-10 * f} fill={PAPER} shadow={SHADOW_BRAND} m={{ d: 0, fy: 14, fr: -24 * f }}>
        <Logo slug="telegram" c={20} size={22} />
      </Card>
      <Card x={x(106, 38)} y={26} w={38} r={12} rot={9 * f} fill={PAPER} shadow={SHADOW_BRAND} m={{ d: 60, fx: 10 * f, fr: 22 * f }}>
        <Logo slug="instagram" c={19} size={21} />
      </Card>
      <Card x={x(66, 34)} y={60} w={34} r={10} rot={-6 * f} fill={PAPER} shadow={SHADOW_BRAND} m={{ d: 120, fy: 16 }}>
        <Logo slug="tiktok" c={17} size={19} />
      </Card>
      <Card x={x(116, 28)} y={70} w={28} r={9} rot={12 * f} fill={LIME} shadow={SHADOW_BRAND} m={{ d: 180, fx: 8 * f, fy: 10, fr: 30 * f }}>
        {heart(14, 14, 15)}
      </Card>
      <Spark cx={x(152)} cy={56} s={8} fill={LIME} />
    </Frame>
  );
}

/** The brand's logo (round) or monogram, 104×104 at (98, 64), inside the Welcome badge. */
function BrandBadge() {
  const b = brandStore.use();
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [b.logoUrl]);
  if (b.logoUrl && !broken) {
    return (
      <>
        <clipPath id="brand-clip">
          <circle cx={150} cy={116} r={52} />
        </clipPath>
        <circle cx={150} cy={116} r={52} style="fill:var(--art-paper)" />
        <image href={b.logoUrl} x={98} y={64} width={104} height={104} preserveAspectRatio="xMidYMid slice" clip-path="url(#brand-clip)" onError={() => setBroken(true)} />
      </>
    );
  }
  return (
    <>
      <circle cx={150} cy={116} r={52} style="fill:var(--brand)" />
      <text x={150} y={118} font-size={52} style="fill:var(--on-brand)">
        {monogram(b.name)}
      </text>
    </>
  );
}

// ---------- A2 Welcome (300×232) ----------

export function ArtWelcome({ enter = true }: { enter?: boolean }) {
  return (
    <Frame vw={300} vh={232} cls={enter ? "welcome-art enter" : "welcome-art"}>
      <Disc cx={150} cy={116} r={100} />
      <Ring cx={150} cy={116} r={112} />
      <g class="a-badge" style="--d:80ms">
        <circle cx={154} cy={124} r={52} style={`fill:${SHADOW}`} />
        <BrandBadge />
        <circle cx={150} cy={116} r={52} class="ink" fill="none" />
      </g>
      <Card x={8} y={34} w={56} r={16} rot={-10} fill={PAPER} m={{ d: 160, fx: 18, fr: -26 }}>
        <Logo slug="telegram" c={28} size={30} />
      </Card>
      <Card x={240} y={22} w={52} r={15} rot={9} fill={PAPER} m={{ d: 240, fx: -18, fr: 24 }}>
        <Logo slug="instagram" c={26} size={28} />
      </Card>
      <Card x={22} y={164} w={50} r={15} rot={7} fill={PAPER} m={{ d: 320, fx: 16, fy: -10 }}>
        <Logo slug="youtube" c={25} size={28} />
      </Card>
      <Card x={224} y={166} w={56} r={16} rot={-8} fill={PAPER} m={{ d: 400, fx: -16, fy: -10 }}>
        <Logo slug="tiktok" c={28} size={28} />
      </Card>
      <Card x={182} y={4} w={34} r={11} rot={12} fill={LIME} m={{ d: 480, fy: 12, fr: 30 }}>
        {heart(17, 17, 18)}
      </Card>
      <Spark cx={40} cy={14} s={10} fill={COBALT} d={500} />
      <Spark cx={282} cy={128} s={9} fill={LIME} ink d={500} />
      <Spark cx={118} cy={214} s={8} fill={PINK} ink d={500} />
    </Frame>
  );
}

// ---------- A3 Language pick (160×128) ----------

const Letter = ({ c, size, dy = 0, children }: { c: number; size: number; dy?: number; children: string }) => (
  <text x={c} y={c + dy} font-size={size}>
    {children}
  </text>
);

export function ArtLanguage({ enter = true }: { enter?: boolean }) {
  return (
    <Frame vw={160} vh={128} cls={enter ? "lang-art enter" : "lang-art"}>
      <Disc cx={80} cy={64} r={54} />
      <Ring cx={80} cy={64} r={60} />
      <Card x={46} y={30} w={68} r={20} rot={-4} fill={LAVS} cls="a-badge">
        <Glyph name="globe" cx={34} cy={34} size={36} />
      </Card>
      <Card x={110} y={8} w={34} r={10} rot={12} fill={LIME} m={{ d: 120, fx: -14, fy: 12, fr: 20 }}>
        <Letter c={17} size={14}>Aa</Letter>
      </Card>
      <Card x={12} y={80} w={32} r={10} rot={-10} fill={PINK} m={{ d: 200, fx: 14, fy: -12, fr: -20 }}>
        <Letter c={16} size={15}>文</Letter>
      </Card>
      <Card x={116} y={84} w={30} r={9} rot={8} fill={SKY} m={{ d: 280, fx: -14, fy: -12, fr: 20 }}>
        <Letter c={15} size={16} dy={-1.5}>ع</Letter>
      </Card>
      <Spark cx={26} cy={22} s={9} fill={COBALT} d={300} />
    </Frame>
  );
}

// ---------- A4 Order placed (200×150, inside .success-art) ----------

/** `waiting`: no check; the screen centres its HTML .spinner on the badge and adds .celebrate once the order is done. */
export function ArtOrderSuccess({ state = "done" }: { state?: "done" | "waiting" }) {
  return (
    <Frame vw={200} vh={150}>
      <Disc cx={100} cy={75} r={70} />
      <g class="a-badge" style="--d:80ms">
        <circle cx={104} cy={83} r={38} style={`fill:${SHADOW}`} />
        <circle cx={100} cy={75} r={38} class="ink" style={`fill:${LIME}`} />
      </g>
      {state === "done" ? (
        <g class="a-glyph" style="--d:260ms">
          <Glyph name="check" cx={100} cy={75} size={38} stroke={2.4} />
        </g>
      ) : null}
      <Card x={14} y={22} w={38} r={12} rot={-10} fill={PAPER} m={{ d: 160, fx: 22, fy: 14, fr: -28 }}>
        {heart(19, 19, 20)}
      </Card>
      <Card x={150} y={96} w={36} r={11} rot={9} fill={PINK} m={{ d: 220, fx: -20, fy: -12, fr: 26 }}>
        <Glyph name="plane" cx={18} cy={18} size={18} />
      </Card>
      <Card x={154} y={16} w={28} r={9} rot={14} fill={SKY} m={{ d: 280, fx: -16, fy: 14, fr: 30 }}>
        {star(14, 14, 15)}
      </Card>
      <Spark cx={36} cy={112} s={10} fill={LIME} ink d={300} />
      <Spark cx={176} cy={70} s={8} fill={COBALT} d={300} />
      <Spark cx={64} cy={10} s={8} fill={PINK} ink d={300} />
    </Frame>
  );
}

// ---------- A5 Top-up success (200×150, inside .success-art) ----------

export function ArtTopUpSuccess() {
  return (
    <Frame vw={200} vh={150}>
      <Disc cx={100} cy={80} r={68} />
      {/* The coin is drawn before the wallet, so the wallet's front hides its bottom ("into the wallet"). */}
      <g class="a-coin" style="--d:120ms">
        <Coin cx={100} cy={52} r={20} star={22} />
      </g>
      <Card x={50} y={62} w={100} h={66} r={16} rot={-4} fill={COBALT} cls="a-squash" m={{ d: 500 }}>
        <path d="M0 20h100" class="ink" />
        <rect x={70} y={30} width={30} height={20} rx={10} class="ink" style={`fill:${LIME}`} />
        <circle cx={80} cy={40} r={3} style={`fill:${INK}`} />
      </Card>
      <Card x={150} y={26} w={30} r={9} rot={12} fill={LIME} m={{ d: 200, fx: -14, fy: 12, fr: 28 }}>
        <Glyph name="plus" cx={15} cy={15} size={16} stroke={2.2} />
      </Card>
      <Card x={18} y={44} w={28} r={9} rot={-10} fill={PINK} m={{ d: 260, fx: 14, fy: 10, fr: -26 }}>
        {heart(14, 14, 14)}
      </Card>
      <Spark cx={40} cy={22} s={9} fill={COBALT} d={300} />
      <Spark cx={176} cy={104} s={8} fill={LIME} ink d={300} />
    </Frame>
  );
}

// ---------- A6–A9 empty and error states (132×104; still, .empty animates the whole svg) ----------

export function ArtEmptyOrders() {
  return (
    <Frame vw={132} vh={104}>
      <Disc cx={66} cy={52} r={44} />
      <Ring cx={66} cy={52} r={50} />
      <Card x={40} y={18} w={52} h={66} r={10} rot={-6} fill={PAPER}>
        <path d="M12 18h28M12 28h28M12 38h18" class="ink" fill="none" stroke-linecap="round" />
        <rect x={12} y={48} width={28} height={8} rx={4} style={`fill:${COBALT}`} />
      </Card>
      <Card x={90} y={8} w={28} r={9} rot={12} fill={LIME}>
        {heart(14, 14, 14)}
      </Card>
      <Card x={12} y={68} w={26} r={8} rot={-10} fill={PINK}>
        <Glyph name="plane" cx={13} cy={13} size={14} />
      </Card>
      <Spark cx={112} cy={74} s={8} fill={LAVS} ink />
    </Frame>
  );
}

export function ArtEmptyWallet() {
  return (
    <Frame vw={132} vh={104}>
      <Disc cx={66} cy={52} r={44} />
      <Ring cx={66} cy={52} r={50} />
      <Card x={30} y={36} w={64} h={46} r={12} rot={-6} fill={LAVS}>
        <path d="M0 14h64" class="ink" />
        <rect x={40} y={20} width={20} height={14} rx={7} class="ink" style={`fill:${PAPER}`} />
        <circle cx={47} cy={27} r={2} style={`fill:${INK}`} />
      </Card>
      <Coin cx={94} cy={28} r={14} star={15} />
      <Card x={12} y={70} w={24} r={8} rot={-10} fill={PINK}>
        <Glyph name="plus" cx={12} cy={12} size={12} stroke={2.2} />
      </Card>
      <Spark cx={114} cy={72} s={8} fill={COBALT} />
    </Frame>
  );
}

export function ArtNoResults() {
  return (
    <Frame vw={132} vh={104}>
      <Disc cx={66} cy={52} r={44} />
      <Ring cx={66} cy={52} r={50} />
      <Card x={26} y={24} w={56} r={14} rot={-8} fill={PAPER}>
        <path d="M12 22h28M12 32h20" class="ink" fill="none" stroke-linecap="round" />
      </Card>
      <circle cx={87} cy={61} r={16} style={`fill:${SHADOW}`} />
      <path d="M98.5 72.5 109 83" stroke-linecap="round" style={`stroke:${SHADOW};stroke-width:4px`} vector-effect="non-scaling-stroke" />
      <path d="M95.5 67.5 106 78" class="ink" stroke-linecap="round" style="stroke-width:4px" />
      <circle cx={84} cy={56} r={16} class="ink" style={`fill:${SKY};stroke-width:2.2px`} />
      <path d="M76 52a9 9 0 0 1 6-6" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" vector-effect="non-scaling-stroke" />
      <Spark cx={104} cy={18} s={10} fill={LIME} ink />
      <circle cx={22} cy={82} r={5} class="ink" style={`fill:${PINK}`} />
    </Frame>
  );
}

export function ArtError({ variant = "error" }: { variant?: "error" | "offline" }) {
  const off = variant === "offline";
  return (
    <Frame vw={132} vh={104}>
      <Disc cx={66} cy={52} r={44} />
      <Card x={36} y={20} w={60} r={16} rot={-8} fill={PAPER}>
        {off ? (
          <Glyph name="wifiOff" cx={30} cy={30} size={30} stroke={2.2} />
        ) : (
          <>
            <path d="M30 16v18" class="ink" stroke-linecap="round" style="stroke-width:3px" />
            <circle cx={30} cy={43} r={2.2} style={`fill:${INK}`} />
          </>
        )}
      </Card>
      <Card x={88} y={60} w={30} r={9} rot={10} fill={off ? SKY : PINK}>
        <Glyph name={off ? "plane" : "refill"} cx={15} cy={15} size={16} />
      </Card>
      <Spark cx={24} cy={22} s={9} fill={LIME} ink />
    </Frame>
  );
}

// ---------- A10 Wallet balance card (150×120, top end of the cobalt card; still) ----------

export function ArtBalanceCard() {
  const { f, x } = mirror(150);
  return (
    <Frame vw={150} vh={120}>
      <BrandRing cx={x(122)} cy={10} r={70} a={0.3} />
      <Card x={x(76, 44)} y={18} w={44} h={32} r={9} rot={10 * f} fill={LIME} shadow={SHADOW_BRAND}>
        <path d={`M${f < 0 ? 13 : 31} 5v22`} class="ink" stroke-dasharray="2 3" style="stroke-width:1.2px" />
      </Card>
      <Coin cx={x(52)} cy={30} r={11} star={13} shadow={SHADOW_BRAND} />
      <Spark cx={x(24)} cy={12} s={8} fill="var(--on-brand)" o={0.8} />
    </Frame>
  );
}

// ---------- registry, generic switch, dev gallery ----------

export type ArtKey = Exclude<ArtName, "none"> | "hero" | "welcome" | "language" | "placed" | "placedWaiting" | "topup" | "balance";

/** Any piece by name. Empty-state names (orders, wallet, search, error, offline) follow the §8.1 usage map. */
export function Art({ name }: { name: ArtKey }): JSX.Element {
  switch (name) {
    case "orders":
      return <ArtEmptyOrders />;
    case "wallet":
      return <ArtEmptyWallet />;
    case "search":
      return <ArtNoResults />;
    case "error":
    case "offline":
      return <ArtError variant={name} />;
    case "hero":
      return <ArtHomeHero />;
    case "welcome":
      return <ArtWelcome />;
    case "language":
      return <ArtLanguage />;
    case "placed":
      return <ArtOrderSuccess />;
    case "placedWaiting":
      return <ArtOrderSuccess state="waiting" />;
    case "topup":
      return <ArtTopUpSuccess />;
    case "balance":
      return <ArtBalanceCard />;
  }
}

// EmptyState / ErrorState in ui.tsx draw their art through this registry (ui.tsx never imports art.tsx).
registerEmptyArt(Art);

const EMPTY: ArtName[] = ["orders", "wallet", "search", "error", "offline"];

/** Dev-only gallery for #/__art (not linked anywhere; labels stay English like the admin panel). */
export function ArtGallery() {
  const [k, setK] = useState(0);
  const [waiting, setWaiting] = useState(false);
  const root = document.documentElement;
  const redraw = (fn: () => void) => () => (fn(), setK(k + 1));
  return (
    <Screen bottom="none" key={k}>
      <LargeTitle title="Art" sub="§8 A1–A10 · toggles redraw everything" />
      <div class="chips">
        <Chip onClick={() => setK(k + 1)}>Replay</Chip>
        <Chip onClick={redraw(() => (root.dataset.theme = root.dataset.theme === "dark" ? "light" : "dark"))}>Theme</Chip>
        <Chip onClick={redraw(() => (root.dir = root.dir === "rtl" ? "ltr" : "rtl"))}>Direction</Chip>
        <Chip selected={waiting} onClick={() => setWaiting(!waiting)}>
          Waiting
        </Chip>
      </div>
      <Section header="A1 ArtHomeHero">
        <div class="hero-card">
          <ArtHomeHero enter />
          <div class="brand">
            <BrandMark size={26} />
            <span class="ellipsis">{brandStore.get().name}</span>
          </div>
          <div class="hi">{t("home.hi", { name: "Alex" })}</div>
          <h1>{t("home.headline")}</h1>
        </div>
      </Section>
      <Section header="A2 ArtWelcome">
        <ArtWelcome />
      </Section>
      <Section header="A3 ArtLanguage">
        <ArtLanguage />
      </Section>
      <Section header={`A4 ArtOrderSuccess (${waiting ? "waiting" : "done"})`}>
        <div class={waiting ? "success-art" : "success-art celebrate"}>
          <ArtOrderSuccess state={waiting ? "waiting" : "done"} />
          {waiting ? <span class="spinner" aria-hidden="true" /> : null}
        </div>
      </Section>
      <Section header="A5 ArtTopUpSuccess">
        <div class="success-art celebrate">
          <ArtTopUpSuccess />
        </div>
      </Section>
      <Section header="A6–A9 EmptyState / ErrorState art">
        <div class="grid2">
          {EMPTY.map((n) => (
            <EmptyState key={n} art={n} title={n} />
          ))}
        </div>
        <div class="card">
          <EmptyState art="wallet" title="wallet (compact)" compact />
        </div>
      </Section>
      <Section header="A10 ArtBalanceCard">
        <div class="balance-card">
          <ArtBalanceCard />
          <div class="lbl">
            <span>{t("wallet.balance")}</span>
            <b class="num-xl">$12.50</b>
          </div>
          <button type="button" class="white-pill">
            + {t("wallet.add")}
          </button>
        </div>
      </Section>
    </Screen>
  );
}
