import { api } from "../api";
import { t } from "../i18n";
import { brandStore } from "../theme";
import { openLink } from "../tg";
import { ErrorState, Sheet, Skeleton, useAsync } from "../ui";

/** In-app terms of service (the owner's text from admin settings), as a bottom sheet. */
export function TermsSheet({ onClose }: { onClose: () => void }) {
  const terms = useAsync(() => api<{ terms: string }>("/terms"), []);
  return (
    <Sheet title={t("profile.terms")} size="large" onClose={onClose}>
      {terms.error ? (
        <ErrorState compact error={terms.error} onRetry={terms.reload} />
      ) : terms.data ? (
        <p class="desc terms-text">{terms.data.terms}</p>
      ) : (
        <Skeleton h={160} />
      )}
    </Sheet>
  );
}

/** The owner's external terms page when set, otherwise false (the caller shows TermsSheet). */
export function openExternalTerms(): boolean {
  const url = brandStore.get().termsUrl;
  if (!url) return false;
  openLink(url);
  return true;
}
