// DELETE /api/me/source : détache la source musicale avant d'en choisir une autre (résultats et
// historique remis à zéro ; préférences, salles et ★ conservés).

import { handle, json } from "../../../_lib/http.js";

export const onRequestDelete = ({ data }) => handle(async () => json(await data.me.detachSource()));
