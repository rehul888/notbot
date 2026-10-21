// Bot display name = "<brand> - <local term>⚡️". The local term is chosen per language:
//   en: SMM Panel - standard English category term
//   es: Panel SMM - "Panel SMM" is the usual Spanish form
//   pt: Painel SMM - "Painel SMM" (Portuguese for panel)
//   ru: Накрутка и SMM - "Накрутка" is the most searched word for buying followers/likes, plus SMM
//   tr: SMM Panel - Turkish market says "SMM Panel" as is
//   ar: لوحة SMM - "لوحة SMM" (panel = لوحة)
//   hi: SMM पैनल - "SMM पैनल" (Devanagari transliteration of panel)
//   id: Panel SMM - Indonesian word order: "Panel SMM"
//   fr: Panel SMM - "Panel SMM" is the common French usage
//   zh: SMM面板 - "SMM面板" (panel = 面板)
//   de: SMM Panel - German market uses "SMM Panel" as is
//   it: Pannello SMM - "Pannello SMM" (Italian for panel)
//   pl: Panel SMM - "Panel SMM" (Polish word order)
//   uk: Накрутка і SMM - "Накрутка" as in Russian, Ukrainian spelling "і"
//   ja: SMMパネル - "SMMパネル" (katakana for panel)
//   ko: SMM 패널 - "SMM 패널" (hangul for panel)
//   vi: SMM Panel - Vietnamese market says "SMM Panel" as is
//   fa: پنل SMM - "پنل SMM" (Persian transliteration of panel)
//   ur: SMM پینل - "SMM پینل" (Urdu transliteration of panel)
//   bn: SMM প্যানেল - "SMM প্যানেল" (Bengali transliteration of panel)
// Bot profile texts (name via setMyName ≤64 chars, setMyShortDescription ≤120 chars, setMyDescription ≤512 chars), per language.
import { type Lang, LANGS } from "../shared/types";
import extra from "./bot-about-extra.json";

export type BotAbout = { name: string; short: string; description: string };

const LIMIT = { name: 64, short: 120, description: 512 };

/** Cuts to `max` UTF-16 units without splitting a surrogate pair. */
function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  let end = max;
  const c = s.charCodeAt(end - 1);
  if (c >= 0xd800 && c <= 0xdbff) end--; // would cut between a surrogate pair
  return s.slice(0, end);
}

/** Builds a text around the brand, shortening only the brand if the result would be too long. */
function fit(max: number, make: (b: string) => string, brand: string): string {
  const full = make(brand);
  if (full.length <= max) return full;
  const b = clip(brand, Math.max(1, brand.length - (full.length - max))).trimEnd();
  return clip(make(b), max);
}

/** Bot profile texts per language with the deployer's brand name inserted, within Telegram's limits. */
export function botAboutFor(brand: string): Record<Lang, BotAbout> {
  const raw = aboutTemplates;
  const out = {} as Record<Lang, BotAbout>;
  for (const l of Object.keys(raw) as Lang[]) {
    const t = raw[l];
    out[l] = {
      name: fit(LIMIT.name, (b) => t.name(b), brand),
      short: clip(t.short, LIMIT.short),
      description: fit(LIMIT.description, (b) => t.description(b), brand),
    };
  }
  return out;
}

type ExtraAbout = { term: string; short: string; description: string };
const EXTRA = extra as Record<string, ExtraAbout>;

/** Languages the bot profile is translated into: the 20 app languages first, then profile-only languages */
export const ABOUT_LANGS: string[] = [...LANGS, ...Object.keys(EXTRA).filter((l) => !(LANGS as readonly string[]).includes(l))];

/** Profile texts for every profile language (app languages + profile-only ones), brand inserted, within limits */
export function botAboutAll(brand: string): Record<string, BotAbout> {
  const out: Record<string, BotAbout> = { ...botAboutFor(brand) };
  for (const [l, t] of Object.entries(EXTRA)) {
    if (out[l]) continue;
    out[l] = {
      name: fit(LIMIT.name, (b) => `${b} - ${t.term}⚡️`, brand),
      short: clip(t.short, LIMIT.short),
      description: fit(LIMIT.description, (b) => t.description.replace("{brand}", b), brand),
    };
  }
  return out;
}

const aboutTemplates: Record<Lang, { name: (b: string) => string; short: string; description: (b: string) => string }> = {
  en: {
    name: (b) => `${b} - SMM Panel⚡️`,
    short: "Grow any social account: followers, views, likes and more for Telegram, Instagram, TikTok and YouTube. Pay with Stars.",
    description:
      (b) => `🚀 ${b}: grow any social account in a few taps.\n\n👥 Followers, subscribers and members\n👁 Views and story views\n❤️ Likes and reactions\n💬 Comments and shares\n\n📱 Telegram, Instagram, TikTok, YouTube, X and more\n⭐️ Pay with Telegram Stars · live order tracking · automatic refunds\n\n👇 Tap Start to begin`,
  },
  es: {
    name: (b) => `${b} - Panel SMM⚡️`,
    short: "Haz crecer cualquier cuenta: seguidores, vistas, likes y más en Telegram, Instagram, TikTok y YouTube. Paga con Stars.",
    description:
      (b) => `🚀 ${b}: haz crecer cualquier cuenta social en unos toques.\n\n👥 Seguidores, suscriptores y miembros\n👁 Vistas y vistas de historias\n❤️ Likes y reacciones\n💬 Comentarios y compartidos\n\n📱 Telegram, Instagram, TikTok, YouTube, X y más\n⭐️ Paga con Telegram Stars · seguimiento de pedidos en vivo · reembolsos automáticos\n\n👇 Toca Iniciar para empezar`,
  },
  pt: {
    name: (b) => `${b} - Painel SMM⚡️`,
    short: "Faça qualquer conta crescer: seguidores, views, curtidas e mais no Telegram, Instagram, TikTok, YouTube. Pague em Stars.",
    description:
      (b) => `🚀 ${b}: faça qualquer conta social crescer em poucos toques.\n\n👥 Seguidores, inscritos e membros\n👁 Visualizações e views de stories\n❤️ Curtidas e reações\n💬 Comentários e compartilhamentos\n\n📱 Telegram, Instagram, TikTok, YouTube, X e mais\n⭐️ Pague com Telegram Stars · acompanhamento de pedidos em tempo real · reembolsos automáticos\n\n👇 Toque em Iniciar para começar`,
  },
  ru: {
    name: (b) => `${b} - Накрутка и SMM⚡️`,
    short: "Раскрутка аккаунтов: подписчики, просмотры, лайки и больше для Telegram, Instagram, TikTok и YouTube. Оплата в Stars.",
    description:
      (b) => `🚀 ${b}: раскрутите любой аккаунт в соцсетях в пару касаний.\n\n👥 Подписчики и участники групп\n👁 Просмотры и просмотры историй\n❤️ Лайки и реакции\n💬 Комментарии и репосты\n\n📱 Telegram, Instagram, TikTok, YouTube, X и другие\n⭐️ Оплата Telegram Stars · отслеживание заказов онлайн · автоматические возвраты\n\n👇 Нажмите «Запустить», чтобы начать`,
  },
  tr: {
    name: (b) => `${b} - SMM Panel⚡️`,
    short: "Her hesabı büyüt: Telegram, Instagram, TikTok ve YouTube için takipçi, izlenme, beğeni ve fazlası. Stars ile öde.",
    description:
      (b) => `🚀 ${b}: her sosyal hesabı birkaç dokunuşla büyüt.\n\n👥 Takipçi, abone ve üyeler\n👁 İzlenmeler ve hikaye izlenmeleri\n❤️ Beğeniler ve tepkiler\n💬 Yorumlar ve paylaşımlar\n\n📱 Telegram, Instagram, TikTok, YouTube, X ve daha fazlası\n⭐️ Telegram Stars ile öde · canlı sipariş takibi · otomatik iadeler\n\n👇 Başlamak için Başlat'a dokun`,
  },
  ar: {
    name: (b) => `${b} - لوحة SMM⚡️`,
    short: "نمِّ أي حساب: متابعون ومشاهدات وإعجابات وأكثر لـ Telegram وInstagram وTikTok وYouTube. ادفع بنجوم Stars.",
    description:
      (b) => `🚀 ${b}: نمِّ أي حساب اجتماعي ببضع نقرات.\n\n👥 متابعون ومشتركون وأعضاء\n👁 مشاهدات ومشاهدات القصص\n❤️ إعجابات وتفاعلات\n💬 تعليقات ومشاركات\n\n📱 Telegram وInstagram وTikTok وYouTube وX والمزيد\n⭐️ ادفع عبر Telegram Stars · تتبّع مباشر للطلبات · استرداد تلقائي\n\n👇 اضغط ابدأ للبدء`,
  },
  hi: {
    name: (b) => `${b} - SMM पैनल⚡️`,
    short: "कोई भी अकाउंट बढ़ाएँ: Telegram, Instagram, TikTok, YouTube पर फॉलोअर्स, व्यूज़, लाइक्स और बहुत कुछ। Stars से भुगतान।",
    description:
      (b) => `🚀 ${b}: किसी भी सोशल अकाउंट को बस कुछ टैप में बढ़ाएँ।\n\n👥 फॉलोअर्स, सब्सक्राइबर और मेंबर\n👁 व्यूज़ और स्टोरी व्यूज़\n❤️ लाइक्स और रिएक्शन\n💬 कमेंट और शेयर\n\n📱 Telegram, Instagram, TikTok, YouTube, X और भी बहुत कुछ\n⭐️ Telegram Stars से भुगतान · लाइव ऑर्डर ट्रैकिंग · ऑटोमैटिक रिफंड\n\n👇 शुरू करने के लिए शुरू करें पर टैप करें`,
  },
  id: {
    name: (b) => `${b} - Panel SMM⚡️`,
    short: "Kembangkan akun apa pun: pengikut, views, like, dan lainnya untuk Telegram, Instagram, TikTok, YouTube. Bayar Stars.",
    description:
      (b) => `🚀 ${b}: kembangkan akun sosial apa pun hanya dengan beberapa ketukan.\n\n👥 Pengikut, subscriber, dan anggota\n👁 Views dan views story\n❤️ Like dan reaksi\n💬 Komentar dan share\n\n📱 Telegram, Instagram, TikTok, YouTube, X, dan lainnya\n⭐️ Bayar dengan Telegram Stars · pelacakan pesanan langsung · refund otomatis\n\n👇 Ketuk Mulai untuk memulai`,
  },
  fr: {
    name: (b) => `${b} - Panel SMM⚡️`,
    short: "Développez tout compte : abonnés, vues, likes et plus sur Telegram, Instagram, TikTok et YouTube. Payez avec Stars.",
    description:
      (b) => `🚀 ${b} : développez n'importe quel compte social en quelques taps.\n\n👥 Abonnés, followers et membres\n👁 Vues et vues de stories\n❤️ Likes et réactions\n💬 Commentaires et partages\n\n📱 Telegram, Instagram, TikTok, YouTube, X et plus\n⭐️ Payez avec Telegram Stars · suivi des commandes en direct · remboursements automatiques\n\n👇 Appuyez sur Démarrer pour commencer`,
  },
  zh: {
    name: (b) => `${b} - SMM面板⚡️`,
    short: "轻松增长任何社交账号：Telegram、Instagram、TikTok、YouTube 的粉丝、播放量、点赞等。用 Stars 支付。",
    description:
      (b) => `🚀 ${b}：轻点几下，增长任何社交账号。\n\n👥 粉丝、订阅者和成员\n👁 播放量和快拍浏览量\n❤️ 点赞和互动表情\n💬 评论和分享\n\n📱 Telegram、Instagram、TikTok、YouTube、X 等平台\n⭐️ 使用 Telegram Stars 支付 · 订单实时追踪 · 自动退款\n\n👇 点击“开始”即可开始`,
  },
  de: {
    name: (b) => `${b} - SMM Panel⚡️`,
    short: "Lass jeden Account wachsen: Follower, Views, Likes und mehr für Telegram, Instagram, TikTok, YouTube. Zahle mit Stars.",
    description:
      (b) => `🚀 ${b}: Lass jeden Social-Account mit ein paar Taps wachsen.\n\n👥 Follower, Abonnenten und Mitglieder\n👁 Views und Story-Views\n❤️ Likes und Reaktionen\n💬 Kommentare und Shares\n\n📱 Telegram, Instagram, TikTok, YouTube, X und mehr\n⭐️ Zahle mit Telegram Stars · Live-Bestellverfolgung · automatische Rückerstattungen\n\n👇 Tippe auf Start, um loszulegen`,
  },
  it: {
    name: (b) => `${b} - Pannello SMM⚡️`,
    short: "Fai crescere ogni account: follower, visualizzazioni, like e altro su Telegram, Instagram, TikTok, YouTube. Paga Stars.",
    description:
      (b) => `🚀 ${b}: fai crescere qualsiasi account social in pochi tocchi.\n\n👥 Follower, iscritti e membri\n👁 Visualizzazioni e visualizzazioni delle storie\n❤️ Like e reazioni\n💬 Commenti e condivisioni\n\n📱 Telegram, Instagram, TikTok, YouTube, X e altro\n⭐️ Paga con Telegram Stars · tracciamento ordini in tempo reale · rimborsi automatici\n\n👇 Tocca Avvia per iniziare`,
  },
  pl: {
    name: (b) => `${b} - Panel SMM⚡️`,
    short: "Rozwijaj każde konto: obserwujący, wyświetlenia, polubienia i więcej na Telegram, Instagram, TikTok, YouTube. Stars.",
    description:
      (b) => `🚀 ${b}: rozwijaj każde konto społecznościowe w kilku dotknięciach.\n\n👥 Obserwujący, subskrybenci i członkowie\n👁 Wyświetlenia i wyświetlenia relacji\n❤️ Polubienia i reakcje\n💬 Komentarze i udostępnienia\n\n📱 Telegram, Instagram, TikTok, YouTube, X i więcej\n⭐️ Płać za pomocą Telegram Stars · śledzenie zamówień na żywo · automatyczne zwroty\n\n👇 Naciśnij Start, aby zacząć`,
  },
  uk: {
    name: (b) => `${b} - Накрутка і SMM⚡️`,
    short: "Розвивайте будь-який акаунт: підписники, перегляди, лайки й більше для Telegram, Instagram, TikTok, YouTube. Stars.",
    description:
      (b) => `🚀 ${b}: розвивайте будь-який акаунт у соцмережах за кілька дотиків.\n\n👥 Підписники, учасники та члени\n👁 Перегляди та перегляди історій\n❤️ Лайки та реакції\n💬 Коментарі та поширення\n\n📱 Telegram, Instagram, TikTok, YouTube, X та інші\n⭐️ Оплата через Telegram Stars · відстеження замовлень наживо · автоматичні повернення коштів\n\n👇 Натисніть «Почати», щоб розпочати`,
  },
  ja: {
    name: (b) => `${b} - SMMパネル⚡️`,
    short: "あらゆるSNSアカウントを成長：Telegram、Instagram、TikTok、YouTubeのフォロワー、再生数、いいねなど。Starsで支払い。",
    description:
      (b) => `🚀 ${b}：数タップでSNSアカウントを成長させましょう。\n\n👥 フォロワー、登録者、メンバー\n👁 再生数とストーリー閲覧数\n❤️ いいねとリアクション\n💬 コメントとシェア\n\n📱 Telegram、Instagram、TikTok、YouTube、Xなど\n⭐️ Telegram Starsで支払い · 注文のリアルタイム追跡 · 自動返金\n\n👇 「開始」をタップしてスタート`,
  },
  ko: {
    name: (b) => `${b} - SMM 패널⚡️`,
    short: "모든 SNS 계정을 성장시키세요: Telegram, Instagram, TikTok, YouTube의 팔로워, 조회수, 좋아요 등. Stars로 결제하세요.",
    description:
      (b) => `🚀 ${b}: 몇 번의 탭으로 모든 SNS 계정을 성장시키세요.\n\n👥 팔로워, 구독자, 멤버\n👁 조회수와 스토리 조회수\n❤️ 좋아요와 리액션\n💬 댓글과 공유\n\n📱 Telegram, Instagram, TikTok, YouTube, X 등\n⭐️ Telegram Stars로 결제 · 실시간 주문 추적 · 자동 환불\n\n👇 시작을 눌러 시작하세요`,
  },
  vi: {
    name: (b) => `${b} - SMM Panel⚡️`,
    short: "Phát triển mọi tài khoản: người theo dõi, lượt xem, lượt thích và hơn nữa cho Telegram, Instagram, TikTok. Dùng Stars.",
    description:
      (b) => `🚀 ${b}: phát triển mọi tài khoản mạng xã hội chỉ với vài lần chạm.\n\n👥 Người theo dõi, người đăng ký và thành viên\n👁 Lượt xem và lượt xem story\n❤️ Lượt thích và cảm xúc\n💬 Bình luận và chia sẻ\n\n📱 Telegram, Instagram, TikTok, YouTube, X và nhiều hơn nữa\n⭐️ Thanh toán bằng Telegram Stars · theo dõi đơn hàng trực tiếp · hoàn tiền tự động\n\n👇 Nhấn Bắt đầu để bắt đầu`,
  },
  fa: {
    name: (b) => `${b} - پنل SMM⚡️`,
    short: "هر حساب را رشد دهید: فالوور، بازدید، لایک و بیشتر برای Telegram، Instagram، TikTok و YouTube. با Stars پرداخت کنید.",
    description:
      (b) => `🚀 ${b}: هر حساب اجتماعی را با چند لمس رشد دهید.\n\n👥 فالوور، مشترک و عضو\n👁 بازدید و بازدید استوری\n❤️ لایک و واکنش\n💬 نظر و اشتراک‌گذاری\n\n📱 Telegram، Instagram، TikTok، YouTube، X و بیشتر\n⭐️ پرداخت با Telegram Stars · پیگیری زندهٔ سفارش · بازپرداخت خودکار\n\n👇 برای شروع روی «شروع» بزنید`,
  },
  ur: {
    name: (b) => `${b} - SMM پینل⚡️`,
    short: "کوئی بھی اکاؤنٹ بڑھائیں: Telegram، Instagram، TikTok، YouTube کے لیے فالوورز، ویوز، لائکس اور مزید۔ Stars سے ادائیگی۔",
    description:
      (b) => `🚀 ${b}: کسی بھی سوشل اکاؤنٹ کو چند ٹیپس میں بڑھائیں۔\n\n👥 فالوورز، سبسکرائبرز اور ممبرز\n👁 ویوز اور اسٹوری ویوز\n❤️ لائکس اور ری ایکشنز\n💬 کمنٹس اور شیئرز\n\n📱 Telegram، Instagram، TikTok، YouTube، X اور مزید\n⭐️ Telegram Stars سے ادائیگی · لائیو آرڈر ٹریکنگ · خودکار ریفنڈز\n\n👇 شروع کرنے کے لیے شروع کریں پر ٹیپ کریں`,
  },
  bn: {
    name: (b) => `${b} - SMM প্যানেল⚡️`,
    short: "যেকোনো অ্যাকাউন্ট বাড়ান: Telegram, Instagram, TikTok, YouTube-এর ফলোয়ার, ভিউ, লাইক ও আরও। Stars দিয়ে পেমেন্ট করুন।",
    description:
      (b) => `🚀 ${b}: মাত্র কয়েকটি ট্যাপে যেকোনো সোশ্যাল অ্যাকাউন্ট বাড়ান।\n\n👥 ফলোয়ার, সাবস্ক্রাইবার ও মেম্বার\n👁 ভিউ ও স্টোরি ভিউ\n❤️ লাইক ও রিঅ্যাকশন\n💬 কমেন্ট ও শেয়ার\n\n📱 Telegram, Instagram, TikTok, YouTube, X এবং আরও অনেক কিছু\n⭐️ Telegram Stars দিয়ে পেমেন্ট · লাইভ অর্ডার ট্র্যাকিং · স্বয়ংক্রিয় রিফান্ড\n\n👇 শুরু করতে শুরু করুন-এ ট্যাপ করুন`,
  },
};

/** @deprecated use botAboutFor(brand); kept so older callers still compile. */
export const BOT_ABOUT = botAboutFor("NotBot");
