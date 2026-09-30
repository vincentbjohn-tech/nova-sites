import { Hono } from 'hono';
import { NovaController } from '../controllers/nova/controller';
import { NovaSitesController as S } from '../controllers/nova/sitesController';
import { adaptController } from '../honoAdapter';
import { AppEnv } from '../../types/appenv';
import { AuthConfig, setAuthLevel } from '../../middleware/auth/routeAuth';

/** Sign-in from Nova OS (see NovaController). */
export function setupNovaRoutes(app: Hono<AppEnv>): void {
    const novaRouter = new Hono<AppEnv>();
    novaRouter.post('/session', setAuthLevel(AuthConfig.public), adaptController(NovaController, NovaController.session));
    novaRouter.get('/enter', setAuthLevel(AuthConfig.public), adaptController(NovaController, NovaController.enter));
    novaRouter.get('/edit.js', setAuthLevel(AuthConfig.public), adaptController(NovaController, NovaController.editScript));

    // Sites (owner-only; contract §2)
    const auth = setAuthLevel(AuthConfig.authenticated);
    novaRouter.get('/sites', auth, adaptController(S, S.list));
    novaRouter.post('/sites', auth, adaptController(S, S.create));
    novaRouter.post('/sites/import', auth, adaptController(S, S.importSite));
    novaRouter.get('/sites/:id', auth, adaptController(S, S.get));
    novaRouter.post('/sites/:id/message', auth, adaptController(S, S.message));
    novaRouter.post('/sites/:id/text', auth, adaptController(S, S.text));
    novaRouter.post('/sites/:id/meta', auth, adaptController(S, S.meta));
    novaRouter.get('/sites/:id/history', auth, adaptController(S, S.history));
    novaRouter.post('/sites/:id/restore', auth, adaptController(S, S.restore));
    novaRouter.post('/sites/:id/publish', auth, adaptController(S, S.publish));
    novaRouter.post('/sites/:id/unpublish', auth, adaptController(S, S.unpublish));
    novaRouter.post('/sites/:id/address', auth, adaptController(S, S.address));

    app.route('/api/nova', novaRouter);
}
