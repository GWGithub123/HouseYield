import { Link } from "react-router-dom";

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-slate-950 text-white">
      <div className="relative overflow-hidden">
        <div className="absolute inset-0 opacity-40">
          <div className="absolute -top-32 -right-32 h-80 w-80 rounded-full bg-blue-500 blur-3xl" />
          <div className="absolute -bottom-40 -left-40 h-96 w-96 rounded-full bg-emerald-400 blur-3xl" />
        </div>

        <div className="relative mx-auto max-w-4xl px-6 py-16 md:py-24">
          <header className="flex items-center justify-between">
            <div className="text-lg font-semibold tracking-wide">HouseYield</div>
          </header>

          <main className="mt-20 text-center">
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-emerald-300">
              Domain verification
            </p>
            <h1 className="mt-4 text-4xl font-bold leading-tight md:text-5xl">
              This is the official domain for HouseYield.
            </h1>

            <div className="mt-10">
              <Link
                to="/about"
                className="inline-block rounded-full bg-white px-8 py-3 text-sm font-semibold text-slate-900 hover:bg-slate-100"
              >
                Learn more about HouseYield
              </Link>
            </div>

            <div className="mx-auto mt-16 grid max-w-3xl gap-4 md:grid-cols-3">
              <div className="rounded-2xl border border-white/10 bg-white/5 p-5">
                <p className="text-sm font-semibold text-white">Verified brand</p>
                <p className="mt-2 text-sm text-white/70">
                  HouseYield is the registered operator of this domain and related services.
                </p>
              </div>
              <div className="rounded-2xl border border-white/10 bg-white/5 p-5">
                <p className="text-sm font-semibold text-white">Private beta</p>
                <p className="mt-2 text-sm text-white/70">
                  We're currently in private development. Public access coming soon.
                </p>
              </div>
              <div className="rounded-2xl border border-white/10 bg-white/5 p-5">
                <p className="text-sm font-semibold text-white">Need support?</p>
                <p className="mt-2 text-sm text-white/70">
                  Contact us at admin@myhouseyield.com for inquiries.
                </p>
              </div>
            </div>
          </main>

          <footer className="mt-20 border-t border-white/10 pt-8 text-center text-sm text-white/50">
            © {new Date().getFullYear()} HouseYield. All rights reserved.
          </footer>
        </div>
      </div>
    </div>
  );
}
