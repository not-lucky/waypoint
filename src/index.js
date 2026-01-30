import express from 'express';

const app = express();
const port = process.env.PORT || 20128;

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.listen(port, () => {
  console.log(`Waypoint listening on port ${port}`);
});
