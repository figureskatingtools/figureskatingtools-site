// The sign-out note: logoutUrl() and the no-access page return here with
// ?signed-out=1. The flag is dropped from the address bar so a reload or a
// bookmark does not show the note again.
const params = new URLSearchParams(location.search);
if (params.has('signed-out')) {
    const note = document.querySelector('.signed-out-note');
    if (note) note.hidden = false;
    history.replaceState(null, '', location.pathname + location.hash);
}
