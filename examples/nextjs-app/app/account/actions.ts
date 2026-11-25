"use server";

import { authalla } from "@/lib/authalla";

// Changes the user's name through the User API. The session is refreshed
// too, so auth() and useAuth() show the new name.
export async function updateName(formData: FormData) {
  const name = String(formData.get("name") ?? "").trim();
  if (name) await authalla.userApi.updateMe({ name });
}
