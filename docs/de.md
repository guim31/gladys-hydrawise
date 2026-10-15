# Hunter Hydrawise

Steuere deine **Hunter-Hydrawise-Bewässerungscomputer** (HC, HPC, Pro-HC, X2 mit WLAN-Modul…)
aus Gladys über die Hydrawise-Cloud: Sieh, welche Zone gerade bewässert wird und wie lange
noch, die nächste geplante Bewässerung jeder Zone, den Regensensor und den heutigen
Wasserverbrauch; bewässere eine Zone ein paar Minuten, stoppe alles, setze das Programm ein paar
Tage aus und setze es fort.

Diese Integration ist nicht mit Hunter Industries verbunden. Hydrawise ist eine Marke von Hunter
Industries.

> **Ohne die Hardware entwickelt: Rückmeldungen willkommen** (Developed without the hardware:
> feedback welcome). Die Integration wurde nach der Hydrawise-API geschrieben, wie die Bibliothek pydrawise
> und die Home-Assistant-Integration sie nutzen, und gegen eine simulierte Cloud getestet. Sag
> uns auf [GitHub](https://github.com/guim31/gladys-hydrawise/issues), was funktioniert und was
> nicht.

## Voraussetzungen

- Gladys Assistant 5.2.0 oder neuer.
- Ein Hydrawise-Steuergerät, das in der Hydrawise-App eingerichtet und mit dem Internet
  verbunden ist.
- Die E-Mail und das Passwort deines Hydrawise-Kontos und/oder dessen API-Schlüssel: auf
  [hydrawise.com](https://app.hydrawise.com/), **Account details**, **API key**.
- Gladys braucht Internetzugang (`app.hydrawise.com` und `api.hydrawise.com`, HTTPS).

## Konfiguration

In Gladys: **Integrationen**, **Hunter Hydrawise**, **Konfiguration**:

| Feld                     | Zweck                                                                                               |
| ------------------------ | --------------------------------------------------------------------------------------------------- |
| E-Mail des Kontos        | Die E-Mail, mit der du dich in der Hydrawise-App anmeldest.                                         |
| Passwort                 | Das Passwort der Hydrawise-App.                                                                     |
| API-Schlüssel (optional) | Mit dem Konto: schnellere Aktualisierung. Allein: funktioniert ohne Konto.                          |
| Dauer der Zonenschalter  | So lange bewässert eine Zone, wenn ihr Schalter eingeschaltet wird (5 bis 60 Minuten, Standard 10). |
| Aussetzen des Programms  | So viele Tage setzt „Automatische Bewässerung“ aus das Programm aus (Standard 2).                   |
| Sprache der Namen        | Sprache der Funktionsnamen und der Texte (Standard: Französisch).                                   |

Dann **Verbindung testen**: Die Integration listet deine Steuergeräte und ihre Zonen auf. Füge
im Tab **Entdecken** jedes Steuergerät zu Gladys hinzu.

### Welche Anmeldung wählen

| Anmeldung             | Aktualisierung der Zonen | Regensensor, Verbrauch, Aussetz-Datum |
| --------------------- | ------------------------ | ------------------------------------- |
| Konto                 | alle 10 Minuten          | ja                                    |
| Konto + API-Schlüssel | alle 2 Minuten           | ja                                    |
| Nur API-Schlüssel     | alle 2 Minuten           | nein                                  |

Das Konto mit seinem API-Schlüssel ist die Einrichtung von Home Assistant und die empfohlene.

### Aktualisierungstakt und Hydrawise-Kontingente

Hydrawise veröffentlicht kein Kontingent, lehnt aber zu häufige Anfragen an seine GraphQL-API
(die des Kontos) ab. Die Integration folgt daher dem Budget der Bibliothek pydrawise, mit dem
Home Assistant läuft: **höchstens 5 GraphQL-Anfragen pro 30 Minuten**. Mit dem Konto allein eine
Abfrage alle 10 Minuten und der heutige Wasserverbrauch einmal pro Stunde. Mit dem API-Schlüssel
werden die Zonen alle 2 Minuten über die ältere REST-API gelesen (oder seltener, wenn Hydrawise
es verlangt, sein `nextpoll`), und die Details alle 30 Minuten über GraphQL. Zwischen zwei
Abfragen wird die Restzeit einer Bewässerung lokal heruntergezählt, ohne Anfrage. Eine
abgelehnte Anfrage (HTTP 429) pausiert diese API 30 Minuten; ein abgelehntes Passwort wird erst
nach 30 Minuten erneut versucht, nie in einer Schleife.

Die Integration aktualisiert sich mit ihrem eigenen Timer: Gladys muss die Geräte nicht abfragen.

## Geräte

Ein Gerät pro Steuergerät, mit diesen Funktionen:

| Funktion                     | Typ                        | Zweck                                                                         |
| ---------------------------- | -------------------------- | ----------------------------------------------------------------------------- |
| Online                       | Ein/Aus, nur lesen         | Das Steuergerät hat Kontakt mit der Hydrawise-Cloud.                          |
| Automatische Bewässerung     | Schalter                   | Aus: setzt alle Zonen für die eingestellten Tage aus. Ein: fortsetzen.        |
| Regensensor                  | Regenerkennung, nur lesen  | Wenn ein Regensensor angeschlossen ist (Anmeldung mit dem Konto).             |
| Wasserverbrauch heute        | Volumen (Liter), nur lesen | Mit einem Durchflussmesser (Anmeldung mit dem Konto), stündlich aktualisiert. |
| _Zone_ · Bewässerung         | Schalter                   | Ein: bewässert die Zone für die eingestellte Dauer. Aus: stoppt sie.          |
| _Zone_ · Restzeit            | Dauer (Minuten)            | Restzeit der Bewässerung, 0 in Ruhe.                                          |
| _Zone_ · nächste Bewässerung | Text                       | Datum der nächsten Bewässerung oder „Ausgesetzt bis…“.                        |
| _Zone_ · Wasser heute        | Volumen (Liter), nur lesen | Mit einem Durchflussmesser.                                                   |

Ein eingeschalteter Zonenschalter bewässert immer nur für eine begrenzte Zeit: Hydrawise stoppt
die Zone am Ende von selbst, auch wenn Gladys nicht läuft.

## Dashboard-Widget

Das Widget **Hydrawise** zeigt die Anzahl der Zonen, die gerade bewässert werden, den heutigen
Wasserverbrauch (mit einem Durchflussmesser) und eine Zeile pro Zone: Bewässerung mit Restzeit,
nächste Bewässerung, ausgesetzt oder nichts geplant. Wähle in seinen Einstellungen ein
Steuergerät oder lass das Feld leer für alle.

Seine Tasten:

- **Bewässern…**: Wähle die Zone und die Dauer (1 bis 240 Minuten).
- **Alles stoppen**: stoppt alle Zonen der angezeigten Steuergeräte.
- **Aussetzen…**: setzt das Programm 1 bis 30 Tage aus.
- **Fortsetzen**: beendet das Aussetzen sofort.

Ein Häkchen auf **Aussetzen…** oder **Fortsetzen** zeigt, ob das Programm ausgesetzt ist.

## Szenen-Auslöser

**Hydrawise: Bewässerung beendet**: Eine Zone hat von selbst aufgehört, am Ende ihrer Dauer oder
ihres Programms (nicht, wenn Gladys sie gestoppt hat). Filtere bei Bedarf nach Steuergerät.
Variablen: der Name der Zone, ihre Nummer, der Name des Steuergeräts und die Bewässerungsdauer in
Minuten.

Um auf den Beginn einer Bewässerung zu reagieren, nutze den Zustand des Zonenschalters
(„_Zone_ · Bewässerung“ geht an) in einem Auslöser „Gerätezustand“.

## Szenen-Aktionen

- **Hydrawise: Zone bewässern**: die Zone über ihre Nummer oder ihren Namen wie in Hydrawise
  (Akzente und Groß-/Kleinschreibung egal) und eine Dauer in Minuten (Standard 10, höchstens
  240). Bei mehreren Steuergeräten wähle das Steuergerät, wenn die Zonennummer auf mehreren
  existiert.
- **Hydrawise: Bewässerung stoppen**: eine Zone oder alle Zonen eines oder aller Steuergeräte.
- **Hydrawise: Bewässerung aussetzen**: für einige Tage (Standard 2), eine Zone oder alle; danach
  läuft das Programm von selbst weiter. Ausgabe: das Ende des Aussetzens.
- **Hydrawise: Bewässerung fortsetzen**: beendet ein Aussetzen sofort.

## Szenen-Beispiele

- **Regen angesagt**: Wenn die Wettervorhersage für morgen Regen meldet, **Hydrawise:
  Bewässerung aussetzen** für 2 Tage.
- **Benachrichtigung am Ende**: Bei **Hydrawise: Bewässerung beendet** schick dir „Bewässerung
  von {{zone}} nach {{minutes}} min beendet“.
- **Jemand im Garten**: Wenn das Gartentor aufgeht, **Hydrawise: Bewässerung stoppen**.
- **Neuer Rasen**: Jeden Tag um 13:00 **Hydrawise: Zone bewässern** „Rasen“ für 5 Minuten.

## Fehlerbehebung

- **„Hydrawise hat die Anmeldung abgelehnt“**: Prüfe E-Mail und Passwort in der Hydrawise-App
  oder den API-Schlüssel auf hydrawise.com. Nach einer Ablehnung wartet die Integration 30
  Minuten, bevor sie es erneut versucht; das Speichern der Konfiguration versucht es sofort.
- **„API-Schlüssel abgelehnt: Das Konto allein aktualisiert die Zonen, langsamer“**: Der
  Schlüssel ist falsch oder widerrufen; erzeuge auf hydrawise.com einen neuen. Bei mehreren
  Steuergeräten kann der Schlüssel nur eines davon bedienen: Die anderen werden dann über das
  Konto aktualisiert.
- **Eine gestartete Zone wird als bewässernd angezeigt, dann passiert nichts**: Das Steuergerät
  holt die Befehle bei seinem nächsten Kontakt aus der Cloud. Die Integration zeigt 3 Minuten
  lang den erwarteten Zustand, dann den von Hydrawise gemeldeten.
- **Die Funktion „Online“ ist aus**: Das Steuergerät hat sein WLAN verloren oder die
  Hydrawise-Cloud antwortet nicht.
- **Mehr Details**: Setze die Variable `LOG_LEVEL` der Integration auf `debug`. Die Protokolle
  enthalten nie das Passwort, den API-Schlüssel oder das Sitzungs-Token.

## Grenzen

- Ohne die Hardware und ohne Hydrawise-Konto entwickelt: Die Anfragen werden gegen das Schema
  des Dienstes geprüft, nicht gegen ein echtes Steuergerät.
- Alles läuft über die Hydrawise-Cloud: keine lokale Steuerung, ohne Internet funktioniert
  nichts.
- Kein momentaner Durchfluss: Die API meldet einen, dessen Bedeutung nicht dokumentiert ist.
- Der Verbrauch braucht die Anmeldung mit dem Konto und einen Durchflussmesser und wird einmal
  pro Stunde aktualisiert.
- Die Programme selbst (Startzeiten, Dauern, Bewässerungstage) bleiben in der Hydrawise-App.
- Nur mit API-Schlüssel: kein Regensensor, kein Verbrauch, und ein Aussetzen hat kein Enddatum.
- Ein Aussetzen des Programms gilt für alle Zonen eines Steuergeräts; setze eine einzelne Zone
  mit der Szenen-Aktion aus.
