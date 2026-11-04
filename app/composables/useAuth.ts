import type { Ref } from "vue";
import type { SessionUser } from "@app/types/auth";

export const useAuth = () => {
  const user: Ref<SessionUser | null> = useState("auth:user", () => null);

  const fetchMe = async () => {
    const requestFetch = useRequestFetch();
    try {
      const res = await requestFetch<{ user: SessionUser }>("/api/auth/me");
      user.value = res.user;
    } catch {
      user.value = null;
    }
    return user.value;
  };

  const login = async (email: string, password: string) => {
    const res = await $fetch<{ user: SessionUser }>("/api/auth/login", {
      method: "POST",
      body: { email, password },
    });
    user.value = res.user;
    return res.user;
  };

  const logout = async () => {
    await $fetch("/api/auth/logout", { method: "POST" });
    user.value = null;
    await navigateTo("/login");
  };

  return { user, fetchMe, login, logout };
};
