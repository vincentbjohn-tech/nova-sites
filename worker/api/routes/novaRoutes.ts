import { Hono } from 'hono';
import { NovaController } from '../controllers/nova/controller';
import { adaptController } from '../honoAdapter';
import { AppEnv } from '../../types/appenv';
import { AuthConfig, setAuthLevel } from '../../middleware/auth/routeAuth';

/** Sign-in from Nova OS (see NovaController). */
export function setupNovaRoutes(app: Hono<AppEnv>): void {
    const novaRouter = new Hono<AppEnv>();
    novaRouter.post('/session', setAuthLevel(AuthConfig.public), adaptController(NovaController, NovaController.session));
    novaRouter.get('/enter', setAuthLevel(AuthConfig.public), adaptController(NovaController, NovaController.enter));
    app.route('/api/nova', novaRouter);
}
