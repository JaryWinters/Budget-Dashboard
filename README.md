# BudgetDashboard

Persoonlijk budget dashboard voor het analyseren van loonstroken, bankuitreksels en Pluxee maaltijdcheques.

## Vereisten

- [Node.js](https://nodejs.org/) v18 of hoger

## Installatie & opstarten

```bash
# 1. Afhankelijkheden installeren
npm install

# 2. Ontwikkelserver starten
npm run dev
```

Open vervolgens [http://localhost:5173](http://localhost:5173) in je browser.

## Bouwen voor productie

```bash
npm run build
```

De gebouwde bestanden staan in de `dist/` map.

## Projectstructuur

```
budget-dashboard/
├── index.html
├── vite.config.js
├── package.json
└── src/
    ├── main.jsx
    └── App.jsx      ← alle logica & UI
```
