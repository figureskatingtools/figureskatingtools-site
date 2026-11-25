/**
 * Trainees of a competition: people the results service names here (not in
 * FS Manager) who get a packet of their own — copies of a judge's or the
 * Technical Specialist's sheets with the trainee's name — for the segments
 * they follow. The list is stored with the competition by the backend
 * (`save_competition_settings` → `trainees`, read back from
 * `get_competition_details`), which re-validates every field (see
 * fs-judgepapers trainees.py). This module holds the data rules, the list
 * shown in the right-hand panel and the add/edit dialog; main.ts owns saving.
 */
import { escapeAttr, escapeHtml } from '../shell.js';

export type TraineeRole = 'judge' | 'technical';

export interface Trainee {
    name: string;
    role: TraineeRole;
    /** FSM file prefixes of the segments, e.g. `FSKMSINGLES-JUNIOR----QUAL000100--` */
    segments: string[];
}

/** A segment the competition has files for, as the options list and the trainee dialog offer it */
export interface SegmentChoice {
    /** The FSM file prefix of the segment's `…_StartListwithTimes.pdf` */
    prefix: string;
    /** `Category - Segment`, as the per-segment options list shows it */
    label: string;
    category: string;
    segment: string;
}

/** Server rules (fs-judgepapers trainees.parse_trainees), mirrored so a 400 is rare */
export const MAX_TRAINEES = 50;
export const TRAINEE_NAME_MAX = 80;
export const MAX_TRAINEE_SEGMENTS = 200;
// eslint-disable-next-line no-control-regex
const NAME_FORBIDDEN = /[/:@<>\\"\u0000-\u001f\u007f]/;

export const ROLE_LABELS: Record<TraineeRole, string> = {
    judge: 'Judge trainee',
    technical: 'Technical trainee',
};

const START_LIST_SUFFIX = '_StartListwithTimes.pdf';

/**
 * Every segment with a time schedule (`…_StartListwithTimes.pdf`), in the
 * order of `get_competition_details`' `structure` ({category: {segment:
 * [files]}}); files of unrecognised categories are left out.
 */
export function segmentChoices(data: unknown): SegmentChoice[] {
    const choices: SegmentChoice[] = [];
    const structure = (data as { structure?: unknown } | null)?.structure;
    if (!structure || typeof structure !== 'object') return choices;
    for (const [category, segments] of Object.entries(structure as Record<string, unknown>)) {
        if (category === 'Uncategorized' || !segments || typeof segments !== 'object') continue;
        for (const [segment, files] of Object.entries(segments as Record<string, unknown>)) {
            if (!Array.isArray(files)) continue;
            const startList = files.find((f: any) => typeof f?.suffix === 'string' && f.suffix.includes('StartListwithTimes'));
            if (startList && typeof startList.filename === 'string') {
                choices.push({
                    prefix: startList.filename.replace(START_LIST_SUFFIX, ''),
                    label: `${category} - ${segment}`,
                    category,
                    segment,
                });
            }
        }
    }
    return choices;
}

/** The trainee list of a details response; a missing or malformed list reads as empty */
export function parseTrainees(raw: unknown): Trainee[] {
    if (!Array.isArray(raw)) return [];
    return raw
        .filter((t): t is Trainee => Boolean(t) && typeof t === 'object'
            && typeof t.name === 'string'
            && (t.role === 'judge' || t.role === 'technical')
            && Array.isArray(t.segments))
        .map(t => ({
            name: t.name,
            role: t.role,
            segments: t.segments.filter((s): s is string => typeof s === 'string'),
        }));
}

/** Whitespace trimmed and collapsed, as the server stores it */
export function normalizeTraineeName(value: string): string {
    return value.trim().split(/\s+/).join(' ');
}

export function isValidTraineeName(value: string): boolean {
    const v = normalizeTraineeName(value);
    return v.length > 0 && v.length <= TRAINEE_NAME_MAX && !NAME_FORBIDDEN.test(v);
}

function segmentCount(n: number): string {
    return `${n} segment${n === 1 ? '' : 's'}`;
}

/** Why "Add trainee" is unavailable, or null when it is available */
export function addTraineeBlocker(trainees: Trainee[], choices: SegmentChoice[]): string | null {
    if (trainees.length >= MAX_TRAINEES) return `The list is full (${MAX_TRAINEES} trainees).`;
    if (!choices.length) return 'Trainees can be added once the time schedules (StartListwithTimes) are uploaded.';
    return null;
}

/**
 * The Trainees section of the right-hand panel. Buttons carry
 * `data-trainee-edit` / `data-trainee-remove` (the row index) and
 * `data-trainee-add`; main.ts handles the clicks on the section.
 */
export function traineesSectionHtml(trainees: Trainee[], choices: SegmentChoice[]): string {
    const known = new Set(choices.map(c => c.prefix));
    const blocker = addTraineeBlocker(trainees, choices);
    const rows = trainees.map((t, i) => {
        const missing = t.segments.filter(s => !known.has(s)).length;
        return `
            <li class="trainee-row">
                <div class="trainee-main">
                    <span class="trainee-name">${escapeHtml(t.name)}</span>
                    <span class="trainee-meta">${escapeHtml(ROLE_LABELS[t.role])} · ${segmentCount(t.segments.length)}</span>
                    ${missing ? `<span class="trainee-note">${missing} not in the current files</span>` : ''}
                </div>
                <div class="trainee-actions">
                    <button type="button" class="btn btn-ghost btn-xs" data-trainee-edit="${i}"
                            aria-label="Edit ${escapeAttr(t.name)}">Edit</button>
                    <button type="button" class="btn btn-ghost btn-ghost--danger btn-xs" data-trainee-remove="${i}"
                            aria-label="Remove ${escapeAttr(t.name)}">Remove</button>
                </div>
            </li>`;
    }).join('');

    return `
        <h3 class="options-title" id="trainees-title" tabindex="-1">Trainees</h3>
        <p class="option-hint trainees-hint">
            Each trainee judge or technical specialist gets a packet of their own: a judge's or the
            Technical Specialist's sheets with the trainee's name, for the segments they follow.
            Trainee papers are added the next time papers are generated.
        </p>
        ${trainees.length ? `<ul class="trainee-list">${rows}</ul>` : ''}
        <div class="trainee-add">
            <button type="button" class="btn btn-sm trainee-add-btn" id="btn-add-trainee" data-trainee-add
                    ${blocker ? 'disabled aria-describedby="trainee-add-hint"' : ''}>Add trainee</button>
            ${blocker ? `<small class="option-hint" id="trainee-add-hint">${escapeHtml(blocker)}</small>` : ''}
        </div>`;
}

const DIALOG_ID = 'trainee-dialog';

export interface TraineeDialogOptions {
    /** The trainee being edited; absent = a new one */
    trainee?: Trainee;
    choices: SegmentChoice[];
    /**
     * Saves the edited trainee. Resolves to null once saved, else to the
     * message for the user (the dialog stays open, so the input is kept).
     */
    onSave: (trainee: Trainee) => Promise<string | null>;
    /** Where focus goes when the dialog closes (the opener may have been re-rendered) */
    returnFocus: () => HTMLElement | null;
}

/** Close an open trainee dialog without saving (e.g. another competition was opened) */
export function closeTraineeDialog(): void {
    const dialog = document.getElementById(DIALOG_ID) as HTMLDialogElement | null;
    if (!dialog) return;
    if (dialog.open) dialog.close();
    dialog.remove();
}

/** The add/edit dialog: name, role and the segments the trainee follows */
export function openTraineeDialog(opts: TraineeDialogOptions): void {
    closeTraineeDialog();
    const editing = opts.trainee;

    // Segments grouped by category, in the order of the files; then whatever
    // the trainee has that the current files lack, so it is not lost silently.
    const groups: { category: string, choices: SegmentChoice[] }[] = [];
    for (const choice of opts.choices) {
        let group = groups.find(g => g.category === choice.category);
        if (!group) groups.push(group = { category: choice.category, choices: [] });
        group.choices.push(choice);
    }
    const known = new Set(opts.choices.map(c => c.prefix));
    const selected = new Set(editing?.segments ?? []);
    const unknown = (editing?.segments ?? []).filter(s => !known.has(s));

    const segmentBox = (prefix: string, label: string, group: string, labelClass = '') => `
        <label class="segment-option">
            <input type="checkbox" name="segment" value="${escapeAttr(prefix)}" data-group="${group}"
                   ${selected.has(prefix) ? 'checked' : ''}>
            <span${labelClass ? ` class="${labelClass}"` : ''}>${escapeHtml(label)}</span>
        </label>`;

    const groupsHtml = groups.map((g, gi) => `
        <div class="trainee-segment-group" role="group" aria-labelledby="${DIALOG_ID}-cat-${gi}">
            <label class="option-check trainee-category-tick">
                <input type="checkbox" data-category-tick="${gi}">
                <span id="${DIALOG_ID}-cat-${gi}">${escapeHtml(g.category)}</span>
            </label>
            <div class="trainee-segment-options">
                ${g.choices.map(c => segmentBox(c.prefix, c.segment, String(gi))).join('')}
            </div>
        </div>`).join('');

    const unknownHtml = unknown.length ? `
        <div class="trainee-segment-group trainee-segment-group--unknown" role="group"
             aria-labelledby="${DIALOG_ID}-unknown-title" aria-describedby="${DIALOG_ID}-unknown-note">
            <span class="trainee-unknown-title" id="${DIALOG_ID}-unknown-title">Not in the current files</span>
            <small class="option-hint" id="${DIALOG_ID}-unknown-note">
                Kept unless you untick them. Papers are made only for segments whose files are uploaded.
            </small>
            <div class="trainee-segment-options">
                ${unknown.map(s => segmentBox(s, s, 'unknown', 'trainee-prefix')).join('')}
            </div>
        </div>` : '';

    const role = editing?.role;
    const dialog = document.createElement('dialog');
    dialog.id = DIALOG_ID;
    dialog.className = 'modal send-dialog trainee-dialog';
    dialog.setAttribute('aria-labelledby', `${DIALOG_ID}-title`);
    dialog.innerHTML = `
      <form method="dialog" class="send-form" novalidate>
        <h3 id="${DIALOG_ID}-title">${editing ? 'Edit trainee' : 'Add trainee'}</h3>

        <div class="send-field">
          <label class="form-label" for="${DIALOG_ID}-name">Name</label>
          <input type="text" id="${DIALOG_ID}-name" name="name" class="form-input" required
                 maxlength="${TRAINEE_NAME_MAX}" autocomplete="off" spellcheck="false"
                 placeholder="First name LAST NAME" value="${escapeAttr(editing?.name ?? '')}"
                 aria-describedby="${DIALOG_ID}-name-note ${DIALOG_ID}-name-error">
          <span class="send-field-note" id="${DIALOG_ID}-name-note">Printed on the trainee's cover and sheets.</span>
          <span class="send-field-error" id="${DIALOG_ID}-name-error" data-error-for="name" hidden>1–${TRAINEE_NAME_MAX} characters, no / : @ &lt; &gt; \\ "</span>
        </div>

        <fieldset class="send-field send-language trainee-role" aria-describedby="${DIALOG_ID}-role-error">
          <legend class="form-label">Role</legend>
          <label><input type="radio" name="role" value="judge" ${role === 'judge' ? 'checked' : ''}> ${ROLE_LABELS.judge}</label>
          <label><input type="radio" name="role" value="technical" ${role === 'technical' ? 'checked' : ''}> ${ROLE_LABELS.technical}</label>
          <span class="send-field-note">A judge trainee gets a judge's sheets, a technical trainee the Technical Specialist's.</span>
          <span class="send-field-error" id="${DIALOG_ID}-role-error" data-error-for="role" hidden>Choose a role.</span>
        </fieldset>

        <fieldset class="send-field trainee-segments" aria-describedby="${DIALOG_ID}-segments-error">
          <legend class="form-label">Segments</legend>
          <div class="trainee-segment-groups">
            ${groupsHtml}
            ${unknownHtml}
            ${groupsHtml || unknownHtml ? '' : '<p class="option-hint">No segments yet: upload the time schedules (StartListwithTimes) first.</p>'}
          </div>
          <span class="send-field-error" id="${DIALOG_ID}-segments-error" data-error-for="segments" hidden></span>
        </fieldset>

        <p class="text-error send-error" data-trainee-error role="alert" hidden></p>

        <div class="modal-actions">
          <button type="button" class="btn btn-ghost btn-sm" data-trainee-cancel>Cancel</button>
          <button type="submit" class="btn btn-primary btn-sm" data-trainee-submit>${editing ? 'Save' : 'Add trainee'}</button>
        </div>
      </form>
    `;
    document.body.appendChild(dialog);

    const form = dialog.querySelector('form')!;
    const nameInput = form.elements.namedItem('name') as HTMLInputElement;
    const roleInputs = Array.from(form.querySelectorAll<HTMLInputElement>('input[name="role"]'));
    const segmentInputs = Array.from(form.querySelectorAll<HTMLInputElement>('input[name="segment"]'));
    const categoryTicks = Array.from(form.querySelectorAll<HTMLInputElement>('input[data-category-tick]'));
    const errorEl = dialog.querySelector<HTMLElement>('[data-trainee-error]')!;
    const submitBtn = dialog.querySelector<HTMLButtonElement>('[data-trainee-submit]')!;
    const cancelBtn = dialog.querySelector<HTMLButtonElement>('[data-trainee-cancel]')!;
    const fieldError = (key: string) => dialog.querySelector<HTMLElement>(`[data-error-for="${key}"]`)!;
    const submitLabel = submitBtn.textContent;

    const selectedRole = (): TraineeRole | null =>
        (roleInputs.find(r => r.checked)?.value as TraineeRole | undefined) ?? null;
    const selectedSegments = (): string[] => segmentInputs.filter(i => i.checked).map(i => i.value);
    const segmentsProblem = (): string | null => {
        const n = selectedSegments().length;
        if (!n) return 'Choose at least one segment.';
        if (n > MAX_TRAINEE_SEGMENTS) return `At most ${MAX_TRAINEE_SEGMENTS} segments.`;
        return null;
    };

    // A category's own tick: on when all its segments are, mixed when some are
    const syncCategoryTicks = () => {
        for (const tick of categoryTicks) {
            const own = segmentInputs.filter(i => i.dataset.group === tick.dataset.categoryTick);
            const on = own.filter(i => i.checked).length;
            tick.checked = on > 0 && on === own.length;
            tick.indeterminate = on > 0 && on < own.length;
        }
    };
    syncCategoryTicks();

    const touched = new Set<string>();
    let saving = false;

    /** Show the errors of the fields the user has been through; true when everything is valid */
    const refresh = (): boolean => {
        const nameOk = isValidTraineeName(nameInput.value);
        const roleOk = selectedRole() !== null;
        const segProblem = segmentsProblem();
        const show = (key: string, valid: boolean) => {
            const visible = !valid && touched.has(key);
            fieldError(key).hidden = !visible;
            return visible;
        };
        nameInput.setAttribute('aria-invalid', String(show('name', nameOk)));
        show('role', roleOk);
        fieldError('segments').textContent = segProblem ?? '';
        show('segments', !segProblem);
        submitBtn.disabled = saving;
        cancelBtn.disabled = saving;
        return nameOk && roleOk && !segProblem;
    };

    nameInput.addEventListener('input', () => {
        // A field already flagged re-validates live; a fresh one waits for blur.
        if (nameInput.getAttribute('aria-invalid') === 'true') touched.add('name');
        refresh();
    });
    nameInput.addEventListener('blur', () => {
        if (nameInput.value.trim()) touched.add('name');
        refresh();
    });
    roleInputs.forEach(r => r.addEventListener('change', () => { touched.add('role'); refresh(); }));
    segmentInputs.forEach(i => i.addEventListener('change', () => {
        syncCategoryTicks();
        touched.add('segments');
        refresh();
    }));
    categoryTicks.forEach(tick => tick.addEventListener('change', () => {
        segmentInputs
            .filter(i => i.dataset.group === tick.dataset.categoryTick)
            .forEach(i => { i.checked = tick.checked; });
        syncCategoryTicks();
        touched.add('segments');
        refresh();
    }));

    const close = (): void => {
        const target = opts.returnFocus();
        dialog.close();
        dialog.remove();
        if (target?.isConnected) target.focus();
    };
    // Closing mid-save would leave the request running with nowhere to report
    // its outcome — the same guard as Escape.
    cancelBtn.addEventListener('click', () => {
        if (!saving) close();
    });
    dialog.addEventListener('cancel', (e) => {
        e.preventDefault();
        if (!saving) close();
    });

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (saving) return;
        ['name', 'role', 'segments'].forEach(k => touched.add(k));
        if (!refresh()) {
            // Focus the first field that needs attention
            if (!isValidTraineeName(nameInput.value)) nameInput.focus();
            else if (!selectedRole()) roleInputs[0]?.focus();
            else (segmentInputs[0] ?? categoryTicks[0])?.focus();
            return;
        }
        const role = selectedRole()!;
        const trainee: Trainee = {
            name: normalizeTraineeName(nameInput.value),
            role,
            segments: selectedSegments(),
        };
        saving = true;
        submitBtn.textContent = 'Saving...';
        errorEl.hidden = true;
        refresh();
        let problem: string | null;
        try {
            problem = await opts.onSave(trainee);
        } catch (_e) {
            problem = 'Could not save the trainees. Try again.';
        }
        saving = false;
        if (!dialog.isConnected) return;   // closed meanwhile (another competition opened)
        if (problem === null) {
            close();
            return;
        }
        submitBtn.textContent = submitLabel;
        errorEl.textContent = problem;
        errorEl.hidden = false;
        refresh();
    });

    dialog.showModal();
    refresh();
    nameInput.focus();
}
