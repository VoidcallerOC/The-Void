import { Link, useRouterState } from "@tanstack/react-router";
import { Menu, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { SignedIn, SignedOut, UserButton } from "@/lib/auth/gates";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { BtnLink, Eyebrow } from "./atoms";

const LINKS = [
  ["Verify", "/verify"],
  ["Artists", "/artists"],
  ["Dashboard", "/dashboard"],
  ["Review", "/review"],
] as const;

function AuthSlot() {
  const { user, isPending } = useCurrentUserState();
  if (isPending) return <div className="h-8 w-8 animate-pulse bg-ash" />;
  if (user) return <UserButton />;
  return (
    <Link
      to="/login"
      className="inline-flex min-h-11 items-center border border-ash px-4 font-body text-[11px] font-bold uppercase tracking-[0.16em] text-bone no-underline hover:border-crimson hover:text-crimson"
    >
      Sign in
    </Link>
  );
}

export function Nav() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 40);
    window.addEventListener("scroll", onScroll);
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  const solid = scrolled || menuOpen;

  return (
    <nav
      className="fixed inset-x-0 top-0 z-50 flex items-center justify-between px-[clamp(16px,4vw,32px)] py-4"
      style={{
        background: solid ? "rgba(0,0,0,0.92)" : "rgba(0,0,0,0.6)",
        backdropFilter: "blur(14px)",
        borderBottom: "1px solid var(--vc-ash)",
      }}
    >
      <div className="flex items-center gap-7">
        <Link to="/" className="flex min-w-0 items-center gap-3 no-underline">
          <img src="/assets/VoidcallerLogo.gif" alt="" width={32} height={32} className="shrink-0" />
          <img src="/assets/voidcaller_wordmark.png" alt="The Void" className="vc-wordmark h-[22px] w-auto max-w-[42vw]" />
        </Link>
        <div className="vc-nav-links hidden items-center gap-[22px] lg:flex">
          {LINKS.map(([label, path]) => (
            <Link
              key={path}
              to={path}
              className={`vc-navlink ${pathname === path || pathname.startsWith(`${path}/`) ? "active" : ""}`}
            >
              {label}
            </Link>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-2.5">
        <span className="vc-nav-cta-extra vc-userchip hidden items-center gap-2.5 sm:flex">
          <AuthSlot />
          <BtnLink to="/verify">Become verified</BtnLink>
        </span>
        <button
          className="vc-nav-burger ml-auto size-11 items-center justify-center border border-smoke text-bone"
          aria-label={menuOpen ? "Close menu" : "Open menu"}
          onClick={() => setMenuOpen((v) => !v)}
        >
          {menuOpen ? <X size={20} strokeWidth={1.75} /> : <Menu size={20} strokeWidth={1.75} />}
        </button>
      </div>

      {menuOpen && (
        <div className="absolute inset-x-0 top-full flex flex-col gap-1 border-b border-ash bg-black/96 px-[clamp(16px,4vw,32px)] pb-7 pt-3">
          {LINKS.map(([label, path]) => (
            <Link
              key={path}
              to={path}
              className="vc-navlink vc-navlink-mobile min-h-12 border-b border-ash py-3.5 text-lg"
            >
              {label}
            </Link>
          ))}
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <AuthSlot />
            <BtnLink to="/verify">Become verified</BtnLink>
          </div>
        </div>
      )}
    </nav>
  );
}

export function Footer() {
  return (
    <footer className="border-t border-ash bg-void px-[clamp(20px,6vw,64px)] pb-12 pt-[clamp(40px,8vw,64px)]">
      <div className="vc-footer-grid grid grid-cols-1 gap-12 md:grid-cols-4">
        <div className="flex flex-col gap-4 md:col-span-2">
          <div className="flex items-center gap-3.5">
            <img src="/assets/VoidcallerLogo.gif" alt="" width={40} height={40} />
            <img src="/assets/voidcaller_wordmark.png" alt="VOIDCALLER" className="h-[26px] w-auto" />
          </div>
          <p className="m-0 max-w-[380px] text-[13px] leading-relaxed text-bone-dim">
            On-chain metalcore. Music as ritual, identity as relic. Verification establishes control — not endorsement.
          </p>
        </div>
        <div>
          <Eyebrow>The Void</Eyebrow>
          <ul className="mt-[18px] flex list-none flex-col gap-2.5 p-0">
            {[
              ["Verify", "/verify"],
              ["Artists", "/artists"],
              ["Dashboard", "/dashboard"],
              ["Review", "/review"],
            ].map(([label, to]) => (
              <li key={to}>
                <Link to={to} className="text-[13px] font-medium text-bone no-underline hover:text-crimson hover:underline">
                  {label}
                </Link>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <Eyebrow>Account</Eyebrow>
          <ul className="mt-[18px] flex list-none flex-col gap-2.5 p-0">
            <li>
              <SignedOut>
                <Link to="/login" className="text-[13px] font-medium text-bone no-underline hover:text-crimson">
                  Sign in
                </Link>
              </SignedOut>
              <SignedIn>
                <Link to="/dashboard" className="text-[13px] font-medium text-bone no-underline hover:text-crimson">
                  Artist dashboard
                </Link>
              </SignedIn>
            </li>
          </ul>
        </div>
      </div>
      <div className="vc-footer-bottom mt-16 flex justify-between border-t border-ash pt-6">
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-bone-dim">
          © MMXXVI · THE VOID · ALL BLEEDS RESERVED
        </span>
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-bone-dim">† AT REST IN THE VOID †</span>
      </div>
    </footer>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="vc-shell">
      <Nav />
      <main className="vc-main">{children}</main>
      <Footer />
    </div>
  );
}
