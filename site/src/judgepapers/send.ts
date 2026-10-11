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

        <label class="send-field">
          <span class="form-label">Recipient e-mail</span>
          <input type="email" name="to" class="form-input" required autocomplete="email"
                 placeholder="print.shop@example.com">
          <span class="send-field-error" data-error-for="to" hidden>Enter one valid e-mail address.</span>
        </label>

        <label class="send-field">
          <span class="form-label">Results Service e-mail</span>
          <input type="email" name="resultsServiceEmail" class="form-input" required autocomplete="email"
                 value="${escapeHtml(userEmail)}">
          <span class="send-field-note">Gets a copy (Cc), and replies from the recipient go here.</span>
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

        <p class="text-error send-error" data-send-error hidden></p>

        <div class="modal-actions">
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

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        for (const [input] of checks) touched.add(input);
        if (!refresh() || sending) return;

        const language = (form.querySelector<HTMLInputElement>('input[name="language"]:checked')?.value ?? 'fi');
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
