# Hunter Hydrawise

Pilotez vos **programmateurs d'arrosage Hunter Hydrawise** (HC, HPC, Pro-HC, X2 avec le module
Wi-Fi…) depuis Gladys, par le cloud Hydrawise : voyez quelle zone arrose et pour combien de
temps, le prochain arrosage prévu de chaque zone, le capteur de pluie et l'eau consommée
aujourd'hui ; arrosez une zone quelques minutes, arrêtez tout, suspendez le programme quelques
jours et reprenez-le.

Cette intégration n'a aucun lien avec Hunter Industries. Hydrawise est une marque de Hunter
Industries.

> **Développée sans le matériel : vos retours sont les bienvenus** (Developed without the
> hardware: feedback welcome). Elle a été écrite d'après l'API Hydrawise telle que l'utilisent
> la bibliothèque pydrawise et l'intégration Home Assistant, et testée contre un cloud simulé.
> Dites-nous ce qui marche et ce qui ne marche pas sur
> [GitHub](https://github.com/guim31/gladys-hydrawise/issues).

## Prérequis

- Gladys Assistant 5.2.0 ou plus récent.
- Un programmateur Hydrawise déjà installé dans l'application Hydrawise, et connecté à
  internet.
- L'e-mail et le mot de passe de votre compte Hydrawise, et/ou sa clé d'API : sur
  [hydrawise.com](https://app.hydrawise.com/), **Account details**, **API key**.
- Gladys doit accéder à internet (`app.hydrawise.com` et `api.hydrawise.com`, en HTTPS).

## Configuration

Dans Gladys, **Intégrations**, **Hunter Hydrawise**, **Configuration** :

| Champ                           | Rôle                                                                                        |
| ------------------------------- | ------------------------------------------------------------------------------------------- |
| E-mail du compte                | L'e-mail avec lequel vous vous connectez à l'application Hydrawise.                         |
| Mot de passe                    | Le mot de passe de l'application Hydrawise.                                                 |
| Clé d'API (facultative)         | Avec le compte : rafraîchissement plus rapide. Seule : fonctionne sans le compte.           |
| Durée des interrupteurs de zone | Durée d'arrosage quand on allume l'interrupteur d'une zone (5 à 60 minutes, 10 par défaut). |
| Suspension du programme         | Nombre de jours de suspension quand on éteint « Arrosage automatique » (2 par défaut).      |
| Langue des noms                 | Langue des noms des fonctionnalités et des textes (français par défaut).                    |

Puis **Tester la connexion** : l'intégration liste vos programmateurs et leurs zones. Dans
l'onglet **Découverte**, ajoutez chaque programmateur à Gladys.

### Quelle connexion choisir

| Connexion          | Rafraîchissement des zones | Capteur de pluie, consommation, dates de suspension |
| ------------------ | -------------------------- | --------------------------------------------------- |
| Compte             | toutes les 10 minutes      | oui                                                 |
| Compte + clé d'API | toutes les 2 minutes       | oui                                                 |
| Clé d'API seule    | toutes les 2 minutes       | non                                                 |

Le compte avec sa clé d'API est la configuration de Home Assistant, et celle que nous
conseillons.

### Rythme de rafraîchissement et quotas Hydrawise

Hydrawise ne publie aucun quota, mais refuse les requêtes trop fréquentes sur son API GraphQL
(celle du compte). L'intégration suit donc le budget de la bibliothèque pydrawise, celui de Home
Assistant : **au plus 5 requêtes GraphQL par 30 minutes**. Avec le compte seul, une lecture
toutes les 10 minutes, et l'eau consommée aujourd'hui une fois par heure. Avec la clé d'API, les
zones sont lues par l'ancienne API REST toutes les 2 minutes (ou moins souvent quand Hydrawise le
demande, son `nextpoll`), et les détails par GraphQL toutes les 30 minutes. Entre deux lectures,
le temps restant d'un arrosage est décompté localement, sans requête. Une requête refusée (HTTP 429) met l'API concernée en pause 30 minutes ; un mot de passe refusé n'est réessayé qu'au bout
de 30 minutes, jamais en boucle.

L'intégration se rafraîchit avec son propre minuteur : Gladys n'a pas besoin d'interroger les
appareils.

## Appareils

Un appareil par programmateur, avec ces fonctionnalités :

| Fonctionnalité             | Type                              | Rôle                                                                                   |
| -------------------------- | --------------------------------- | -------------------------------------------------------------------------------------- |
| En ligne                   | Marche/arrêt, lecture seule       | Le programmateur est en contact avec le cloud Hydrawise.                               |
| Arrosage automatique       | Interrupteur                      | Éteint : suspend toutes les zones pour le nombre de jours configuré. Allumé : reprend. |
| Capteur de pluie           | Détection de pluie, lecture seule | Quand un capteur de pluie est branché (connexion par le compte).                       |
| Eau consommée aujourd'hui  | Volume (litres), lecture seule    | Avec un débitmètre (connexion par le compte), rafraîchi chaque heure.                  |
| _zone_ · arrosage          | Interrupteur                      | Allumé : arrose la zone pendant la durée configurée. Éteint : l'arrête.                |
| _zone_ · temps restant     | Durée (minutes)                   | Temps restant de l'arrosage, 0 au repos.                                               |
| _zone_ · prochain arrosage | Texte                             | Date du prochain arrosage, ou « Suspendue jusqu'au… ».                                 |
| _zone_ · eau aujourd'hui   | Volume (litres), lecture seule    | Avec un débitmètre.                                                                    |

Allumer l'interrupteur d'une zone arrose toujours pour une durée limitée : Hydrawise arrête la
zone de lui-même à la fin, même si Gladys est arrêté.

## Widget du tableau de bord

Le widget **Hydrawise** affiche le nombre de zones en arrosage, l'eau consommée aujourd'hui
(avec un débitmètre), et une ligne par zone : en arrosage avec le temps restant, prochain
arrosage, suspendue, ou rien de prévu. Choisissez un programmateur dans ses réglages, ou laissez
vide pour tous.

Ses boutons :

- **Arroser…** : choisissez la zone et la durée (1 à 240 minutes).
- **Tout arrêter** : arrête toutes les zones des programmateurs affichés.
- **Suspendre…** : suspend le programme de 1 à 30 jours.
- **Reprendre** : termine la suspension tout de suite.

Une coche sur **Suspendre…** ou **Reprendre** indique si le programme est suspendu.

## Déclencheur de scène

**Hydrawise : arrosage terminé** : une zone a fini d'arroser d'elle-même, à la fin de sa durée
ou de son programme (pas quand Gladys l'a arrêtée). Filtrez par programmateur si besoin.
Variables : le nom de la zone, son numéro, le nom du programmateur et la durée d'arrosage en
minutes.

Pour réagir au début d'un arrosage, utilisez l'état de l'interrupteur de la zone
(« _zone_ · arrosage » s'allume) dans un déclencheur « état d'un appareil ».

## Actions de scène

- **Hydrawise : arroser une zone** : la zone par son numéro ou son nom comme dans Hydrawise
  (accents et majuscules ignorés), et une durée en minutes (10 par défaut, 240 au plus). Avec
  plusieurs programmateurs, choisissez le programmateur quand le numéro de zone existe sur
  plusieurs.
- **Hydrawise : arrêter l'arrosage** : une zone, ou toutes les zones d'un programmateur ou de
  tous.
- **Hydrawise : suspendre l'arrosage** : pour un nombre de jours (2 par défaut), une zone ou
  toutes ; le programme reprend seul ensuite. Sortie : la fin de la suspension.
- **Hydrawise : reprendre l'arrosage** : termine une suspension tout de suite.

## Exemples de scènes

- **Pluie annoncée** : quand la météo annonce de la pluie pour demain, **Hydrawise : suspendre
  l'arrosage** pendant 2 jours.
- **Notification à la fin** : sur **Hydrawise : arrosage terminé**, envoyez-vous « Arrosage de
  {{zone}} terminé après {{minutes}} min ».
- **Quelqu'un au jardin** : quand le portillon du jardin s'ouvre, **Hydrawise : arrêter
  l'arrosage**.
- **Nouveau gazon** : tous les jours à 13:00, **Hydrawise : arroser une zone** « Pelouse »
  pendant 5 minutes.

## Dépannage

- **« Hydrawise a refusé la connexion »** : vérifiez l'e-mail et le mot de passe dans
  l'application Hydrawise, ou la clé d'API sur hydrawise.com. Après un refus, l'intégration
  attend 30 minutes avant de réessayer ; enregistrer la configuration réessaie tout de suite.
- **« Clé d'API refusée : le compte seul rafraîchit les zones, plus lentement »** : la clé est
  fausse ou révoquée ; générez-en une nouvelle sur hydrawise.com. Avec plusieurs programmateurs,
  la clé peut ne servir qu'un seul d'entre eux : les autres sont alors rafraîchis par le compte.
- **Une zone lancée s'affiche en arrosage, puis rien ne se passe** : le programmateur récupère
  les commandes sur le cloud à son prochain contact. L'intégration affiche l'état attendu pendant
  3 minutes, puis l'état que rapporte Hydrawise.
- **La fonctionnalité « En ligne » est éteinte** : le programmateur a perdu son Wi-Fi, ou le
  cloud Hydrawise ne répond pas.
- **Plus de détails** : passez la variable `LOG_LEVEL` de l'intégration à `debug`. Les logs ne
  contiennent jamais le mot de passe, la clé d'API ni le jeton de session.

## Limites

- Développée sans le matériel ni compte Hydrawise : les requêtes sont vérifiées contre le schéma
  du service, pas contre un vrai programmateur.
- Tout passe par le cloud Hydrawise : pas de pilotage local, rien ne fonctionne sans internet.
- Pas de débit instantané : l'API en rapporte un dont le sens n'est pas documenté.
- La consommation demande la connexion par le compte et un débitmètre, et se rafraîchit une fois
  par heure.
- Les programmes eux-mêmes (heures de départ, durées, jours d'arrosage) restent dans
  l'application Hydrawise.
- Avec la clé d'API seule : ni capteur de pluie, ni consommation, et une suspension n'a pas de
  date de fin.
- Une suspension du programme s'applique à toutes les zones d'un programmateur ; suspendez une
  seule zone avec l'action de scène.
