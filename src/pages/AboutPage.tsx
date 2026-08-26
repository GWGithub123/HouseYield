import { Link } from "react-router-dom";

export default function AboutPage() {
  return (
    <div className="min-h-screen bg-slate-950 text-white">
      <div className="relative overflow-hidden">
        <div className="absolute inset-0 opacity-40">
          <div className="absolute -top-32 -right-32 h-80 w-80 rounded-full bg-blue-500 blur-3xl" />
          <div className="absolute -bottom-40 -left-40 h-96 w-96 rounded-full bg-emerald-400 blur-3xl" />
        </div>

        <div className="relative mx-auto max-w-4xl px-6 py-16 md:py-24">
          <header className="flex items-center justify-between">
            <Link to="/" className="text-lg font-semibold tracking-wide">
              HouseYield
            </Link>
            <Link
              to="/"
              className="rounded-full border border-white/30 px-4 py-2 text-sm text-white/90 hover:border-white hover:text-white"
            >
              ← Back
            </Link>
          </header>

          <main className="mt-16">
            <h1 className="text-4xl font-bold leading-tight md:text-5xl">
              About HouseYield
            </h1>
            <p className="mt-6 text-lg text-white/80">
              HouseYield is a comprehensive property management and real estate
              analytics platform designed to help property owners, tenants, and
              contractors streamline their workflows.
            </p>

            <div className="mt-12 grid gap-6 md:grid-cols-2">
              <div className="rounded-2xl border border-white/10 bg-white/5 p-6">
                <h2 className="text-xl font-semibold">For Property Owners</h2>
                <p className="mt-3 text-white/70">
                  Manage your portfolio, track financials, handle maintenance
                  requests, and gain insights into property performance—all in
                  one place.
                </p>
              </div>

              <div className="rounded-2xl border border-white/10 bg-white/5 p-6">
                <h2 className="text-xl font-semibold">For Tenants</h2>
                <p className="mt-3 text-white/70">
                  Submit maintenance requests, make rent payments, and
                  communicate with your landlord through a simple, modern
                  interface.
                </p>
              </div>

              <div className="rounded-2xl border border-white/10 bg-white/5 p-6">
                <h2 className="text-xl font-semibold">For Contractors</h2>
                <p className="mt-3 text-white/70">
                  Access job listings, view property details, and coordinate
                  repairs efficiently with property managers.
                </p>
              </div>

              <div className="rounded-2xl border border-white/10 bg-white/5 p-6">
                <h2 className="text-xl font-semibold">Smart Analytics</h2>
                <p className="mt-3 text-white/70">
                  Leverage data-driven insights to make better investment
                  decisions and optimize property returns.
                </p>
              </div>
            </div>

            <div className="mt-12 rounded-2xl border border-white/10 bg-white/5 p-6">
              <h2 className="text-xl font-semibold">Coming Soon</h2>
              <p className="mt-3 text-white/70">
                HouseYield is currently in private development. We're building
                something special and will announce public availability soon.
                Stay tuned!
              </p>
            </div>
          </main>

          <footer className="mt-16 border-t border-white/10 pt-8 text-center text-sm text-white/50">
            © {new Date().getFullYear()} HouseYield. All rights reserved.
          </footer>
        </div>
      </div>
    </div>
  );
}
