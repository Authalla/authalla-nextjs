"use server";

import { authalla } from "@/lib/authalla";

export async function signOutAction() {
  await authalla.signOut();
}
