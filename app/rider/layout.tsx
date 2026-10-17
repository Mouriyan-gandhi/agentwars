import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import LogoutButton from "../LogoutButton";

export default async function RiderLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect("/login/rider");
  if (session.role !== "rider") redirect("/login/rider");

  return (
    <div>
      <nav className="mx-auto flex max-w-[1280px] items-center justify-between px-6 py-5 md:px-10">
        <div className="flex items-center gap-3 rounded-full bg-limestone px-5 py-2.5">
          <div className="h-7 w-7 rounded-full bg-ember" />
          <div className="text-body font-medium">ParcelPilot</div>
          <span className="text-caption text-obsidian/60">Rider</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-body-sm text-obsidian/70">{session.display_name}</span>
          <LogoutButton />
        </div>
      </nav>
      {children}
    </div>
  );
}
