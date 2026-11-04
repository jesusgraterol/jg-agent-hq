import { verifyDeploymentWhenLive } from './public-destinations/index.ts';

// GitHub Pages can serve part of the previous deployment for a while; 6 attempts 30 s apart wait
// up to 2.5 minutes, inside the deploy job's 10-minute limit
await verifyDeploymentWhenLive({ attempts: 6, delayMs: 30_000 });
