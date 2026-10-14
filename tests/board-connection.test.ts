import {describe,it,expect} from 'vitest';
import {migrateSettings,DEFAULT_SETTINGS} from '../src/settings-config.js';
import {resolveBoardConnection,boardConnectionKey} from '../src/board-connection.js';

describe('effective drawing connection',()=>{
  it('migrates once to inherit and retains independent models and keys',()=>{
    const old={...DEFAULT_SETTINGS,boardConnectionMode:undefined,chatEngine:'api',apiKey:'private',apiModel:'sidebar',boardEngine:'opencode',boardAgentModel:'saved/model',boardApiModel:'saved-api'};
    const settings=migrateSettings(old);
    expect(resolveBoardConnection(settings)).toEqual({engine:'api',model:'sidebar',mode:'inherit'});
    expect(settings).toMatchObject({apiKey:'private',boardAgentModel:'saved/model',boardApiModel:'saved-api'});
    const custom=migrateSettings({...settings,boardConnectionMode:'custom'});
    expect(resolveBoardConnection(custom)).toEqual({engine:'opencode',model:'saved/model',mode:'custom'});
    expect(migrateSettings(custom)).toEqual(custom);
  });
  it('follows the sidebar engine, model and credentials; dormant presets do not recycle a connection',()=>{
    const base={...DEFAULT_SETTINGS,chatEngine:'api' as const,apiModel:'vision'};
    const key=boardConnectionKey(base);
    for(const changed of [{apiModel:'other'},{apiKey:'new'},{apiBaseUrl:'https://other'},{chatEngine:'opencode' as const},{boardConnectionMode:'custom' as const}])
      expect(boardConnectionKey({...base,...changed})).not.toBe(key);
    expect(boardConnectionKey({...base,boardAgentModel:'unused',boardApiModel:'unused'})).toBe(key);
    expect(resolveBoardConnection({...base,chatEngine:'opencode',agentModel:'current/vision'}).model).toBe('current/vision');
  });
  it('independent empty model inherits that engine’s configured model',()=>{
    const base={...DEFAULT_SETTINGS,boardConnectionMode:'custom' as const,boardEngine:'api' as const,boardApiModel:'  ',apiModel:'default'};
    expect(resolveBoardConnection(base)).toEqual({engine:'api',model:'default',mode:'custom'});
    expect(boardConnectionKey({...base,boardApiModel:'custom'})).not.toBe(boardConnectionKey(base));
  });
});
