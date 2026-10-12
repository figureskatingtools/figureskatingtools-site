/**
 * "Send judges' papers" dialog: e-mails a fresh download link of one merged
 * judges'-papers PDF through the backend's `send_judge_papers` endpoint, which
 * re-validates every field (see fs-judgepapers email_sender.py).
 */
import { escapeHtml, type UserInfo } from '../shell.js';

const DIALOG_ID = 'send-papers-dialog';

/** Only the merged daily PDFs are sendable (the mail text describes them). */
export const SENDABLE_FILE_RE = /^judgingpapers_[A-Za-z0-9_-]+\.pdf$/;

// Same single-address pattern as the backend's email_sender._EMAIL_RE.
const EMAIL_RE =
    /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;
const SENDER_NAME_MAX = 80;
// eslint-disable-next-line no-control-regex
const SENDER_NAME_FORBIDDEN = /[/:@<>\\"\u0000-\u001f\u007f]/;

function isValidEmail(value: string): boolean {
    const v = value.trim();
    return v.length <= 254 && EMAIL_RE.test(v) && v.split('@')[0].length <= 64;
}

function normalizeName(value: string): string {
    return value.trim().split(/\s+/).join(' ');
}

function isValidSenderName(value: string): boolean {
    const v = normalizeName(value);
    return v.length > 0 && v.length <= SENDER_NAME_MAX && !SENDER_NAME_FORBIDDEN.test(v);
}

/** Default sender name: the principal's name claim, else the e-mail's local part. */
function defaultSenderName(user: UserInfo): string {
    if (user.name && isValidSenderName(user.name)) return normalizeName(user.name);
    const local = (user.userDetails || '').split('@')[0];
    return local
        .split(/[._-]+/)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ');
}

export function openSendDialog(apiBase: string, competitionId: string, fileName: string, user: UserInfo): void {
    document.getElementById(DIALOG_ID)?.remove();

    const userEmail = isValidEmail(user.userDetails || '') ? user.userDetails.trim() : '';

    const dialog = document.createElement('dialog');
    dialog.id = DIALOG_ID;
    dialog.className = 'modal send-dialog';
    dialog.innerHTML = `
      <form method="dialog" class="send-form" novalidate>
        <h3>Send judges' papers</h3>
        <p class="modal-message">
          E-mails a ready-made message with a fresh download link to
          <strong>${escapeHtml(fileName)}</strong>. The link is valid for up to 5 days.
        </p>

        <div data-send-fields>
        <label class="send-field">
          <span class="form-label">Recipient e-mail</span>
          <input type="email" name="to" class="form-input" required autocomplete="email"
                 placeholder="competition.manager@example.com">
          <span class="send-field-error" data-error-for="to" hidden>Enter one valid e-mail address.</span>
        </label>

        <label class="send-field">
          <span class="form-label">Results Service e-mail</span>
          <input type="email" name="resultsServiceEmail" class="form-input" required autocomplete="email"
                 value="${escapeHtml(userEmail)}">
          <span class="send-field-note">Gets a copy (Cc).</span>
          <span class="send-field-error" data-error-for="resultsServiceEmail" hidden>Enter one valid e-mail address.</span>
        </label>

        <label class="send-field">
          <span class="form-label">Sender name</span>
          <input type="text" name="senderName" class="form-input" required maxlength="${SENDER_NAME_MAX}"
                 autocomplete="name" value="${escapeHtml(defaultSenderName(user))}">
          <span class="send-field-note">Signs the message, above "Tulospalvelu" / "Results Service".</span>
          <span class="send-field-error" data-error-for="senderName" hidden>1–${SENDER_NAME_MAX} characters, no / : @ &lt; &gt;</span>
        </label>

        <fieldset class="send-field send-language">
          <legend class="form-label">Message language</legend>
          <label><input type="radio" name="language" value="fi" checked> Suomi</label>
          <label><input type="radio" name="language" value="en"> English</label>
        </fieldset>
        </div>

        <section class="send-preview" data-send-preview hidden>
          <dl class="send-preview-meta">
            <dt>From</dt><dd data-preview="from"></dd>
            <dt>To</dt><dd data-preview="to"></dd>
            <dt>Cc</dt><dd data-preview="cc"></dd>
            <dt>Subject</dt><dd data-preview="subject"></dd>
          </dl>
          <div class="send-preview-body" data-send-preview-body></div>
          <p class="send-field-note">The download link is created when the e-mail is sent.</p>
        </section>

        <p class="text-error send-error" data-send-error hidden></p>

        <div class="modal-actions">
          <button type="button" class="btn btn-ghost btn-sm send-preview-toggle" data-send-preview-toggle>Preview</button>
          <button type="button" class="btn btn-ghost btn-sm" data-send-cancel>Cancel</button>
          <button type="submit" class="btn btn-primary btn-sm" data-send-submit disabled>Send</button>
        </div>
      </form>
    `;
    document.body.appendChild(dialog);

    const form = dialog.querySelector('form')!;
    const toInput = form.elements.namedItem('to') as HTMLInputElement;
    const ccInput = form.elements.namedItem('resultsServiceEmail') as HTMLInputElement;
    const nameInput = form.elements.namedItem('senderName') as HTMLInputElement;
    const errorEl = dialog.querySelector<HTMLElement>('[data-send-error]')!;
    const submitBtn = dialog.querySelector<HTMLButtonElement>('[data-send-submit]')!;
    const fieldsEl = dialog.querySelector<HTMLElement>('[data-send-fields]')!;
    const previewEl = dialog.querySelector<HTMLElement>('[data-send-preview]')!;
    const previewBtn = dialog.querySelector<HTMLButtonElement>('[data-send-preview-toggle]')!;
    const selectedLanguage = (): string =>
        form.querySelector<HTMLInputElement>('input[name="language"]:checked')?.value ?? 'fi';

    const checks: Array<[HTMLInputElement, (v: string) => boolean]> = [
        [toInput, isValidEmail],
        [ccInput, isValidEmail],
        [nameInput, isValidSenderName],
    ];
    const touched = new Set<HTMLInputElement>();
    let sending = false;
    let sent = false;

    const refresh = (): boolean => {
        let allValid = true;
        for (const [input, check] of checks) {
            const valid = check(input.value);
            allValid &&= valid;
            const showError = !valid && touched.has(input);
            input.setAttribute('aria-invalid', String(showError));
            dialog.querySelector<HTMLElement>(`[data-error-for="${input.name}"]`)!.hidden = !showError;
        }
        submitBtn.disabled = sending || !allValid;
        return allValid;
    };
    for (const [input] of checks) {
        input.addEventListener('input', () => {
            // A field already flagged re-validates live; a fresh one waits for blur.
            if (input.getAttribute('aria-invalid') === 'true') touched.add(input);
            refresh();
        });
        input.addEventListener('blur', () => {
            if (input.value.trim()) touched.add(input);
            refresh();
        });
    }

    const close = (): void => {
        dialog.close();
        dialog.remove();
    };
    dialog.querySelector('[data-send-cancel]')!.addEventListener('click', close);
    dialog.addEventListener('cancel', (e) => {
        if (sending) e.preventDefault();
        else close();
    });

    // Preview: the backend renders the exact e-mail (same templates as the
    // send) without minting a link or counting toward the send limit.
    const showFields = (): void => {
        previewEl.hidden = true;
        fieldsEl.hidden = false;
        dialog.classList.remove('send-dialog--preview');
        previewBtn.textContent = 'Preview';
    };
    previewBtn.addEventListener('click', async () => {
        if (!previewEl.hidden) {
            showFields();
            return;
        }
        touched.add(nameInput);
        refresh();
        if (!isValidSenderName(nameInput.value)) return;
        previewBtn.disabled = true;
        errorEl.hidden = true;
        try {
            const resp = await fetch(`${apiBase}/preview_judge_papers_email`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    id: competitionId,
                    fileName,
                    to: toInput.value.trim(),
                    resultsServiceEmail: ccInput.value.trim(),
                    senderName: normalizeName(nameInput.value),
                    language: selectedLanguage(),
                }),
            });
            if (!resp.ok) {
                errorEl.textContent = resp.status === 401
                    ? 'Your session has expired. Reload the page and sign in again.'
                    : (await resp.text()) || `Preview failed (HTTP ${resp.status}).`;
                errorEl.hidden = false;
                return;
            }
            renderPreview(previewEl, await resp.json());
            fieldsEl.hidden = true;
            previewEl.hidden = false;
            dialog.classList.add('send-dialog--preview');
            previewBtn.textContent = 'Edit';
        } catch (_err) {
            errorEl.textContent = 'Preview failed. Check your connection and try again.';
            errorEl.hidden = false;
        } finally {
            previewBtn.disabled = false;
        }
    });

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        for (const [input] of checks) touched.add(input);
        if (!refresh()) {
            showFields();
            return;
        }
        if (sending) return;

        const language = selectedLanguage();
        const to = toInput.value.trim();
        sending = true;
        submitBtn.textContent = 'Sending...';
        refresh();
        errorEl.hidden = true;

        try {
            const resp = await fetch(`${apiBase}/send_judge_papers`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    id: competitionId,
                    fileName,
                    to,
                    resultsServiceEmail: ccInput.value.trim(),
                    senderName: normalizeName(nameInput.value),
                    language,
                }),
            });
            if (resp.ok) {
                const data = await resp.json();
                sent = true;
                showSent(dialog, to, ccInput.value.trim(), data.expiryDisplay, Boolean(data.dryRun), close);
                return;
            }
            const text = resp.status === 401
                ? 'Your session has expired. Reload the page and sign in again.'
                : (await resp.text()) || `Sending failed (HTTP ${resp.status}).`;
            errorEl.textContent = text;
            errorEl.hidden = false;
        } catch (_err) {
            errorEl.textContent = 'Sending failed. Check your connection and try again.';
            errorEl.hidden = false;
        } finally {
            sending = false;
            // After a successful send the form has been replaced by the result.
            if (!sent) {
                submitBtn.textContent = 'Send';
                refresh();
            }
        }
    });

    dialog.showModal();
    refresh();
    toInput.focus();
}

interface EmailPreview {
    subject: string;
    from: string;
    to: string | null;
    cc: string | null;
    html: string;
}

/**
 * Show the rendered e-mail. Its HTML comes from our backend with every
 * user-supplied value escaped; it is still parsed inertly (DOMParser runs no
 * scripts) and shown in a shadow root so the mail's styles stay isolated.
 * Not an iframe: the site CSP (frame-ancestors 'none') applies to srcdoc too.
 */
function renderPreview(previewEl: HTMLElement, preview: EmailPreview): void {
    const missing = '— (not filled in yet)';
    const meta: Record<string, string> = {
        from: preview.from,
        to: preview.to || missing,
        cc: preview.cc || missing,
        subject: preview.subject,
    };
    for (const [key, value] of Object.entries(meta)) {
        previewEl.querySelector<HTMLElement>(`[data-preview="${key}"]`)!.textContent = value;
    }

    const parsed = new DOMParser().parseFromString(preview.html, 'text/html');
    parsed.querySelectorAll('script, iframe, object, embed').forEach((el) => el.remove());
    const host = previewEl.querySelector<HTMLElement>('[data-send-preview-body]')!;
    const root = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
    const body = document.createElement('div');
    body.setAttribute('style', parsed.body.getAttribute('style') ?? '');
    body.append(...Array.from(parsed.body.childNodes, (node) => document.importNode(node, true)));
    // The link is minted only at send time; keep preview clicks inert.
    body.addEventListener('click', (e) => {
        if ((e.target as Element).closest('a')) e.preventDefault();
    });
    root.replaceChildren(body);
}

function showSent(dialog: HTMLDialogElement, to: string, cc: string, expiry: string, dryRun: boolean,
                  close: () => void): void {
    dialog.innerHTML = `
      <h3>${dryRun ? 'Dry run — not sent' : 'E-mail sent'}</h3>
      <p class="modal-message">
        ${dryRun
            ? 'E-mail sending is not configured on this server, so the message was only logged.'
            : `Sent to <strong>${escapeHtml(to)}</strong>, with a copy to <strong>${escapeHtml(cc)}</strong>.`}
        The link is valid until ${escapeHtml(expiry || '-')}.
      </p>
      <div class="modal-actions">
        <button type="button" class="btn btn-primary btn-sm" data-send-close>Close</button>
      </div>
    `;
    dialog.querySelector<HTMLButtonElement>('[data-send-close]')!.addEventListener('click', close);
    dialog.querySelector<HTMLButtonElement>('[data-send-close]')!.focus();
}
