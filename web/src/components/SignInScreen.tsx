import { type FormEvent, useState } from "react";
import { errorMessage } from "../lib/errors.ts";
import { choosePassword, SignInPaused, type Signin, signInWithPassword } from "../lib/signin.ts";
import { toast } from "./Toast.tsx";

/**
 * The page a visitor who is not signed in gets, per method.
 *
 * It used to be prose telling people to go edit `docker/.env`, because there was
 * no credential to type. Now three of the four methods get a real control here,
 * and the fourth (`cf-access`) explains what to do instead, since its credential
 * is a cookie Cloudflare puts on the request before it ever reaches the app.
 */

interface Props {
  signin: Signin;
  /** No password exists yet: the first visitor picks it, and claims the instance. */
  setupRequired: boolean;
}

/** A session was just minted: reload so every screen loads under it. */
function enter() {
  window.location.assign("/");
}

function refusalOf(cause: unknown): string {
  return cause instanceof SignInPaused
    ? `Too many attempts — try again in ${cause.retryAfter}s.`
    : errorMessage(cause);
}

function PasswordForm({ setup }: { setup: boolean }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (setup && password !== confirm) {
      setError("The two passwords do not match.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      if (setup) await choosePassword(password);
      else await signInWithPassword(password);
      enter();
    } catch (cause) {
      setError(refusalOf(cause));
      setBusy(false);
    }
  };

  if (setup) {
    return (
      <form className="signin-form" onSubmit={submit}>
        <label className="field">
          Password
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="at least 10 characters"
            autoComplete="new-password"
          />
          <span className="small">
            Ten characters or more. It is not stored anywhere in plain text.
          </span>
        </label>
        <label className="field">
          Repeat password
          <input
            type="password"
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            placeholder="the same again"
            autoComplete="new-password"
          />
        </label>
        {error ? <p className="warning small">{error}</p> : null}
        <button className="button" type="submit" disabled={busy || !password}>
          Set password &amp; continue
        </button>
      </form>
    );
  }

  return (
    <form className="signin-form" onSubmit={submit}>
      <label className="field">
        Password
        <input
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="current-password"
        />
      </label>
      {error ? <p className="warning small">{error}</p> : null}
      <button className="button" type="submit" disabled={busy || !password}>
        Sign in
      </button>
    </form>
  );
}

export function SignInScreen({ signin, setupRequired }: Props) {
  if (signin === "password") {
    return (
      <main className="shell center">
        <h1>Lettuce</h1>
        {setupRequired ? (
          <>
            <p className="muted">First run — choose the password this instance signs in with.</p>
            <PasswordForm setup />
            <p className="warning small">
              Anyone who reaches this page before you do can claim this instance. Set the password
              before you join an untrusted network, and keep the port closed until then.
            </p>
          </>
        ) : (
          <>
            <p className="muted">Sign in to continue.</p>
            <PasswordForm setup={false} />
          </>
        )}
      </main>
    );
  }

  if (signin === "google") {
    return (
      <main className="shell center">
        <h1>Lettuce</h1>
        <p className="muted">Sign in with the Google account this instance allows.</p>
        <div className="signin-form">
          <a className="button" href="/auth/google/start">
            Sign in with Google
          </a>
        </div>
        <p className="muted small">
          Uses the same Google client as Settings → Google Workspace, set once in
          <code>docker/.env</code>, with this origin listed as an authorised redirect URI. Only
          addresses in the allowlist get in.
        </p>
      </main>
    );
  }

  if (signin === "none") {
    return (
      <main className="shell center">
        <h1>Lettuce</h1>
        <p className="muted">
          This instance signs nobody in — anyone who can reach this address is the owner. It only
          listens on this machine.
        </p>
        <div className="signin-form">
          <a className="button" href="/auth/login">
            Continue
          </a>
        </div>
        <p className="muted small">
          To put it on your network or the internet, set <code>SIGNIN=password</code> in
          <code>docker/.env</code>. Sign-in is required anywhere the port leaves this machine.
        </p>
      </main>
    );
  }

  // Cloudflare Access: its login is a redirect the app cannot start from inside
  // the page, so the page's job is to say reload.
  return (
    <main className="shell center">
      <h1>Lettuce</h1>
      <p className="muted">
        Not signed in. This instance is reached through Cloudflare Access — if you are seeing this
        on the tunnel, reload; direct access without Access is not supported.
      </p>
      <div className="signin-form">
        <button
          type="button"
          className="button"
          onClick={() => {
            toast("Reloading…");
            enter();
          }}
        >
          Reload
        </button>
      </div>
    </main>
  );
}
