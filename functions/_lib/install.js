// Mode d'emploi « Installer sur l'écran d'accueil » (version 1.9.0), affiché sur la page
// d'invitation (page sans script : contenu fixe, blocs <details>). Même texte dans le site
// (site/account.js, INSTALL_HELP) : modifier les deux ensemble.

export const INSTALL_STYLE = `
  .install { margin-top: 1.6em; padding: 12px 16px; border-radius: 10px; background: rgba(30, 35, 80, .06); }
  .install summary { cursor: pointer; font-weight: 600; }
  .install details { margin-top: .6em; }
  .install ol { margin: .4em 0 0; }
  @media (prefers-color-scheme: dark) { .install { background: rgba(236, 233, 246, .08); } }`;

export const INSTALL_HELP = `<section class="install">
  <h2 style="margin-top:0">Installer l'application sur votre téléphone</h2>
  <p class="note">Une icône sur l'écran d'accueil ouvre le site comme une application. À faire <strong>après la connexion, depuis la page du site</strong> (pas depuis cette page d'invitation, dont le lien ne sert qu'une fois).</p>
  <details><summary>iPhone, avec Safari</summary><ol>
    <li>Touchez le bouton Partager (carré avec une flèche vers le haut, en bas de l'écran).</li>
    <li>Faites défiler, puis touchez « Sur l'écran d'accueil ».</li>
    <li>Touchez « Ajouter ».</li></ol></details>
  <details><summary>iPhone, avec Chrome</summary><ol>
    <li>Touchez le bouton Partager, à droite de la barre d'adresse.</li>
    <li>Touchez « Ajouter à l'écran d'accueil », puis « Ajouter ».</li></ol></details>
  <details><summary>Android, avec Chrome</summary><ol>
    <li>Touchez le menu ⋮ en haut à droite.</li>
    <li>Touchez « Ajouter à l'écran d'accueil » (ou « Installer l'application »).</li>
    <li>Touchez « Ajouter ».</li></ol></details>
  <details><summary>Android, avec Samsung Internet</summary><ol>
    <li>Touchez le menu ☰ en bas à droite.</li>
    <li>Touchez « Ajouter la page à », puis « Écran d'accueil ».</li></ol></details>
</section>`;
