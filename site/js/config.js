// Adresse du service des rooms (dossier worker/, voir README section « Rooms »).
// Vide : les rooms sont désactivées sur le site. En local, le service lancé par `wrangler dev` est utilisé.
const DEPLOYED = "";

const local = ["localhost", "127.0.0.1"].includes(location.hostname);
export const ROOMS_API = local ? "http://localhost:8787" : DEPLOYED;
