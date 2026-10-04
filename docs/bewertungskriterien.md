# Bewertungskriterien für die Demo-Anwendung

Ziel der Belegarbeit ist die Entwicklung einer IT-Infrastruktur, welche verlässlich auf hohe Auslastung und Ausfälle reagieren kann bzw. Probleme zuverlässig erkennt.

## Anforderungen

- [✅] Eine Kurzdokumentation als `README.md`-Datei beschreibt wie Anwendung bedient wird (1 Punkt)
- [✅] Alle notwendigen Dateien, `Dockerfiles`, Container-Images sind in der Abgabe enthalten oder in zugänglichen Repositories (bspw. `ghcr`) verfügabr. (1 Punkt)
- Die Infrastruktur kann mit `docker-compose` gestartet werden (4 Punkte)
    - [✅]  Wenn Schritte zur Initialisierung notwendig sind (bspw. Datenbank-Tabellen anlegen o.ä.) werden diese automatisch ausgeführt
    - [✅] Die Webanwendung kann über die in der `README.md` angegebene URL aufgerufen werden.
    - [✅] Die Webanwendung besitzt einen in der `README.md` angegebene Endpunkt an den Daten gesendet werden (bspw. ein API-Call oder Form-Submit).
    - [✅] Es existiert eine **URL** mit welcher der Health-Status der Anwendung überprüft werden kann.
- [✅] Persistente Daten sind in Docker Volumes abgelegt und bleiben nach Neustart der Infrasturktur erhalten. (1 Punkt)
- Lasttests (12 Punkte)
    - Der Web-Endpunkt zum Anzeigen der Webseite funktioniert:
        - [✅] für 10 parallele Anfragen (0 Sekunden Ramp-up).
        - [✅] für 100 parallele Anfragen (1 Sekunde Ramp-up).
        - [✅] für 1000 parallele Anfragen (5 Sekunden Ramp-up).
        - [✅] für 1000 parallele Anfragen (1 Sekunde Ramp-up).
        - [✅] für 1000 Anfragen pro Minute über 10 Minuten.
    - Der Daten verarbeitende Web-Endpunkt funktioniert:
        - [✅] für 10 parallele Anfragen (0 Sekunden Ramp-up, normale Requests).
        - [✅] für 100 parallele Anfragen (1 Sekunde Ramp-up, normale Requests).
        - [✅] für 1000 parallele Anfragen (5 Sekunden Ramp-up, normale Requests).
        - [✅] für 10 parallele Anfragen (0 Sekunden Ramp-up, 5 MB Request Body).
        - [✅] für 100 parallele Anfragen (1 Sekunde Ramp-up, 5 MB Request Body).
        - [✅] für 1000 parallele Anfragen (5 Sekunden Ramp-up, 5 MB Request Body, Requests dürfen bspw. mit HTTP 429 abgewiesen werden).
        - [✅] für 1000 parallele Anfragen (5 Sekunden Ramp-up, 5 MB Request Body, Requests werden ordnungsgemäß beantwortet).
- Verfügbarkeit (6 Punkte)  
    - [✅] Der Ausfall eines Webservers für das Frontend beeinflusst nicht die Verfügbarkeit der Anwendung.
    - [✅] Der Ausfall des Backend wird im Monitoring angezeigt.
    - [✅] Bei Ausfall des Backend zeigt das Frontend eine passende Fehlermeldung.
    - [✅] Der Ausfall des Datenbank wird im Monitoring angezeigt.
    - [✅] Bei Ausfall der Datenbank zeigt das Frontend eine passende Fehlermeldung.
    - [✅] Bei Überlastung einzelner Dienste skaliert der Dienst horizontal (Scale-Out).
- Monitoring (6 Punkte)
    - [✅] Die Services besitzen Health-Checks.
    - [✅] Die Services besitzen geeignete Abhängigkeiten um eine geordnete Start-Reihenfolge sicherzustellen.
    - [✅] Stürzt ein Container unerwartet ab wird dies erkannt und angezeigt.
    - [✅] Stürzt ein Container unerwartet ab wird dieser automatisch neu gestartet.
    - [✅] Überwachungslimits für die Container sind konfiguriert.
    - [✅] Benachrichtigungen werden versendet bei überschreiten von Überwachungslimits.
- Security (5 Punkte)
    - [✅] Dienste sind sinnvoll in verschiedenen Netzen isoliert.
    - [✅] Kommunikation mit Endpunkten erfolgt SSL-Verschlüsselt (selbst-signiertes Zertifikat ist ausreichend).
    - [✅] Passwörter und sonstige Geheimnisse sind nicht in `docker inspect` sichtbar sondern mit **Docker Secrets** oder verschlüsselten `.env`-Dateien umgesetzt.
    - [✅] Es sind keine unnötigen Ports exponiert.
    - [✅] Zusätzliche Maßnahmen wie **Read Only**-Dateisysteme oder Capabilities wurden implementiert oder ausprobiert und dokumentiert.
- Sonstiges (4 Punkte)
    - [✅] Die Infrastruktur enthält eine Web-Application-Firewall (WAF)
    - [✅] Für die eigenen erstellen Docker-Images wurde ein Sicherheitsscan durchgeführt und dokumentiert.
    - [✅] Der Sicherheitsscan findet keine kritischen Schwachstellen.
    - [✅] Ein automatisiertes Datenbank-Backup für die Datenbank ist eingerichtet.