import LoginForm from "../LoginForm";

export default function AdminLoginPage() {
  return (
    <LoginForm
      role="admin"
      title="Admin login"
      blurb="Watch the agentic workflow run live."
      demo={[{ email: "admin@parcelpilot.dev", password: "admin123" }]}
    />
  );
}
