import LoginForm from "../LoginForm";

export default function RiderLoginPage() {
  return (
    <LoginForm
      role="rider"
      title="Rider login"
      blurb="See your assigned orders and report delivery issues."
      demo={[
        { email: "arjun@parcelpilot.dev", password: "rider123" },
        { email: "priya@parcelpilot.dev", password: "rider123" },
        { email: "rohan@parcelpilot.dev", password: "rider123" },
      ]}
    />
  );
}
