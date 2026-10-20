import { useEffect, useState } from "preact/hooks";
import { ErrorState, Screen, Skeleton, SkeletonList } from "./ui";

type AdminProps = { parts: string[]; query: URLSearchParams };

let adminModule: Promise<typeof import("./admin/AdminRoutes")> | null = null;

/** Loads the admin chunk once; a failed load is forgotten so a retry fetches it again. */
function loadAdmin() {
  if (!adminModule) {
    adminModule = import("./admin/AdminRoutes");
    adminModule.catch(() => {
      adminModule = null;
    });
  }
  return adminModule;
}

/** Admin panel, downloaded only when an owner opens #/admin. */
export function LazyAdminRoutes(props: AdminProps) {
  const [mod, setMod] = useState<typeof import("./admin/AdminRoutes") | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [round, setRound] = useState(0);

  useEffect(() => {
    let live = true;
    setError(null);
    loadAdmin().then(
      (m) => live && setMod(m),
      (e) => live && setError(e),
    );
    return () => {
      live = false;
    };
  }, [round]);

  if (mod) return <mod.AdminRoutes {...props} />;
  if (error)
    return (
      <Screen bottom="none" center>
        <ErrorState error={error} onRetry={() => setRound((n) => n + 1)} />
      </Screen>
    );
  return (
    <Screen bottom="none">
      <Skeleton h={44} />
      <SkeletonList rows={5} />
    </Screen>
  );
}

let publicModule: Promise<typeof import("./setup/PublicPages")> | null = null;

/** Setup wizard / "open in Telegram" page for plain browsers, downloaded only there. */
export function LazyPublicPages() {
  const [mod, setMod] = useState<typeof import("./setup/PublicPages") | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [round, setRound] = useState(0);

  useEffect(() => {
    let live = true;
    setError(null);
    if (!publicModule) {
      publicModule = import("./setup/PublicPages");
      publicModule.catch(() => {
        publicModule = null;
      });
    }
    publicModule.then(
      (m) => live && setMod(m),
      (e) => live && setError(e),
    );
    return () => {
      live = false;
    };
  }, [round]);

  if (mod) return <mod.PublicPages />;
  if (error)
    return (
      <Screen bottom="none" center>
        <ErrorState error={error} onRetry={() => setRound((n) => n + 1)} />
      </Screen>
    );
  return (
    <Screen bottom="none">
      <Skeleton h={44} />
      <SkeletonList rows={3} />
    </Screen>
  );
}
