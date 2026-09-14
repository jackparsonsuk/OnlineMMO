import { CLASSES, getOstra, isClassId } from "@mmo/shared";
import { AccountClient, ApiError, type CharacterSummary } from "./account.js";

/**
 * Sign in, then pick a character.
 *
 * Deliberately plain DOM rather than a framework: it is two forms and a list,
 * shown once before the game starts, and adding a UI library for it would
 * double the client bundle to save fifty lines.
 */

export async function showTitleScreen(account: AccountClient): Promise<CharacterSummary> {
  const root = document.getElementById("title") as HTMLElement;
  root.hidden = false;

  // A stored token that still works skips the sign-in entirely.
  const restored = await account.restore();
  if (!restored) await signInStep(root, account);

  const character = await characterStep(root, account);
  // The art stays up while the world is built behind it: hiding it here
  // showed an empty canvas for as long as the join and the first ground took.
  // `leaveTitleScreen` takes it down once there is something to look at.
  panel(root, `
    <h1>${escapeHtml(character.name)}</h1>
    <p class="tagline">Stepping through to ${escapeHtml(getOstra(character.ostraId).name)}…</p>
    <p class="error" hidden></p>
  `).classList.add("entering");
  return character;
}

/** The world is in: fade the title away. */
export function leaveTitleScreen(): void {
  const root = document.getElementById("title") as HTMLElement;
  if (root.hidden) return;
  root.classList.add("leaving");
  window.setTimeout(() => {
    root.hidden = true;
    root.classList.remove("leaving");
  }, 600);
}

/** Entering failed: say so where the player is looking. */
export function titleScreenError(message: string): void {
  const error = document.querySelector<HTMLElement>("#title .error");
  if (!error) return;
  error.textContent = message;
  error.hidden = false;
}

/** Render a panel and hand back its elements. */
function panel(root: HTMLElement, html: string): HTMLElement {
  root.innerHTML = `<div class="title-panel">${html}</div>`;
  return root.querySelector(".title-panel") as HTMLElement;
}

function signInStep(root: HTMLElement, account: AccountClient): Promise<void> {
  return new Promise((resolve) => {
    let mode: "signIn" | "register" = "signIn";

    const draw = (): void => {
      const registering = mode === "register";
      // The name is in the art above the panel; the panel says what to do.
      const box = panel(root, `
        <h1>${registering ? "Create an account" : "Sign in"}</h1>
        <p class="tagline">The Gates are opening again.</p>
        <form>
          <label>Email<input name="email" type="email" autocomplete="username" required /></label>
          <label>Password<input name="password" type="password"
            autocomplete="${registering ? "new-password" : "current-password"}" required /></label>
          <p class="hint">${registering ? "At least 10 characters." : "&nbsp;"}</p>
          <button type="submit">${registering ? "Create account" : "Sign in"}</button>
          <p class="error" hidden></p>
        </form>
        <button class="link">${registering
          ? "I already have an account"
          : "I need an account"}</button>
      `);

      const form = box.querySelector("form") as HTMLFormElement;
      const error = box.querySelector(".error") as HTMLElement;
      const submit = box.querySelector("button[type=submit]") as HTMLButtonElement;

      (box.querySelector(".link") as HTMLButtonElement).onclick = () => {
        mode = registering ? "signIn" : "register";
        draw();
      };

      form.onsubmit = (event) => {
        event.preventDefault();
        const data = new FormData(form);
        const email = String(data.get("email") ?? "");
        const password = String(data.get("password") ?? "");

        error.hidden = true;
        submit.disabled = true;
        submit.textContent = registering ? "Creating…" : "Signing in…";

        const action = registering
          ? account.register(email, password)
          : account.signIn(email, password);

        action.then(resolve).catch((cause: unknown) => {
          error.textContent = cause instanceof ApiError
            ? cause.message
            : "Could not reach the server.";
          error.hidden = false;
          submit.disabled = false;
          submit.textContent = registering ? "Create account" : "Sign in";
        });
      };

      (form.querySelector("input[name=email]") as HTMLInputElement).focus();
    };

    draw();
  });
}

function characterStep(root: HTMLElement, account: AccountClient): Promise<CharacterSummary> {
  return new Promise((resolve, reject) => {
    const draw = (characters: CharacterSummary[]): void => {
      const box = panel(root, `
        <h1>Your travellers</h1>
        <div class="roster-list"></div>
        <form class="make">
          <label>New traveller<input name="name" maxlength="16"
            placeholder="Name" autocomplete="off" /></label>
          <button type="submit">Begin</button>
        </form>
        <p class="error" hidden></p>
        <button class="link sign-out">Sign out</button>
      `);

      const list = box.querySelector(".roster-list") as HTMLElement;
      const error = box.querySelector(".error") as HTMLElement;

      if (characters.length === 0) {
        list.innerHTML = `<p class="hint">Nobody yet. Name your first.</p>`;
      }

      for (const character of characters) {
        const entry = document.createElement("button");
        entry.className = "roster-entry";
        const what = isClassId(character.classId) ? CLASSES[character.classId].name : "";
        entry.innerHTML =
          `<span class="who">${escapeHtml(character.name)}</span>` +
          `<span class="where">${character.level !== undefined ? `Level ${character.level} ${what} · ` : ""}` +
          `${escapeHtml(getOstra(character.ostraId).name)}</span>`;
        entry.onclick = () => resolve(character);
        list.appendChild(entry);
      }

      (box.querySelector(".sign-out") as HTMLButtonElement).onclick = () => {
        account.signOut();
        // Straight back to the sign-in form, without a reload.
        signInStep(root, account).then(() => load()).catch(reject);
      };

      const form = box.querySelector(".make") as HTMLFormElement;
      form.onsubmit = (event) => {
        event.preventDefault();
        const name = String(new FormData(form).get("name") ?? "").trim();
        error.hidden = true;
        account.createCharacter(name)
          .then(resolve)
          .catch((cause: unknown) => {
            error.textContent = cause instanceof ApiError ? cause.message : "Could not create that.";
            error.hidden = false;
          });
      };
    };

    const load = (): void => {
      account.characters().then(draw).catch(reject);
    };

    load();
  });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[char] as string));
}
