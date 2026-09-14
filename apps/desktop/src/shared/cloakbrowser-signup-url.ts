/**
 * Where an operator gets their own CloakBrowser key.
 *
 * The product ships no key. `cloakBrowserLicenseKey` defaults to `""`, each
 * operator registers with the vendor themselves, and the key they paste is
 * stored per machine. Two people sharing one key share its seat limit, and the
 * refusal that follows is indistinguishable from a crash — so the app points
 * every operator at their own registration instead.
 *
 * Deliberately a literal, and deliberately not derived from
 * `CLOAKBROWSER_DOWNLOAD_BASE`: that base is overridable by the environment for
 * tests and self-hosting, and this string is handed to the operating system's
 * browser. An env var that can retarget a download is a much smaller problem
 * than one that can retarget where a person types their credentials.
 */
export const CLOAKBROWSER_FREE_KEY_URL = "https://cloakbrowser.dev/free";
