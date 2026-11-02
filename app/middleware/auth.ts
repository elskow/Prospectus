export default defineNuxtRouteMiddleware(async (to) => {
  const { user, fetchMe } = useAuth();
  if (user.value === null) {
    await fetchMe();
  }
  if (!user.value) {
    return navigateTo("/login", { replace: true });
  }
  if (to.path === "/login") {
    return navigateTo("/settings", { replace: true });
  }
});
