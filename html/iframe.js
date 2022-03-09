var sessionID;
window.onload = e => {
    sessionID = encodeURIComponent(sessionStorage.getItem('sessionID'));
}
window.onbeforeunload = e => {
    navigator.sendBeacon('/endSession?sessionID=' + sessionID);
};