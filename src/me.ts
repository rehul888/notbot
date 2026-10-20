import type { Me } from "../shared/types";
import { api } from "./api";
import { meStore } from "./store";
import { applyBrand } from "./theme";

export async function refreshMe(): Promise<Me> {
  const me = await api<Me>("/me");
  meStore.set(me);
  if (me.brand) applyBrand(me.brand);
  return me;
}

export async function updateMe(body: Record<string, unknown>): Promise<Me> {
  const me = await api<Me>("/me", { method: "PATCH", body });
  meStore.set(me);
  if (me.brand) applyBrand(me.brand);
  return me;
}
