
/*
  This program and the accompanying materials are
  made available under the terms of the Eclipse Public License v2.0 which accompanies
  this distribution, and is available at https://www.eclipse.org/legal/epl-v20.html
  
  SPDX-License-Identifier: EPL-2.0
  
  Copyright Contributors to the Zowe Project.
*/

'use strict';
const util = require('util');
const fs = require('fs');
const http = require('http');
const https = require('https');
const url = require('url');
const path = require('path');
const os = require('os');
const assert = require('assert');
const requireFromString = require('require-from-string');
const EventEmitter = require('events');
const semver = require('semver');
const zluxUtil = require('./util');
const jsonUtils = require('./jsonUtils.js');
const configService = require('../plugins/config/lib/configService.js');
const DependencyGraph = require('./depgraph');

/**
 * Plugin loader: reads the entire plugin configuration tree
 * 
 *  - resolves plugin refs
 *  - reads plugin definition files
 *  - loads any supplemental modules required by plugins
 *  - performs some validation 
 * 
 */
const bootstrapLogger = zluxUtil.loggers.bootstrapLogger;

const defaultOptions = {
  productCode: null,
  authManager: null,
  pluginsDir: null,
  serverConfig: null
}

function Service(def, configuration, plugin) {
  this.configuration = configuration;
  //don't do this here: avoid circular structures:
  //this.plugin = plugin; 
  Object.assign(this, def);
  if (this.version === undefined) {
    //FIXME temporary hack until everyone has fixed their plugin defs.
    bootstrapLogger.warn(`Service ${plugin.identifier}::${this.name} doesn't` 
      + ` specify a version. Resorting to the plugin's API version ${plugin.apiVersion}`);
    this.version = plugin.apiVersion;
  }
}
Service.prototype = {
  constructor: Service,
  
  validate() {
    if (!semver.valid(this.version)) {
      throw new Error(`${this.name}: invalid version "${this.version}"`)
    }
  }
}

function Import(def, configuration, plugin) {
  Service.call(this, def, configuration, plugin);
}
Import.prototype = {
  constructor: Import,
  __proto__:  Service.prototype,
  
  validate() {
    if (!semver.validRange(this.versionRange)) {
      throw new Error(`${this.localName}: invalid version range "${this.versionRange}"`)
    }
  }
}

function NodeService(def, configuration, plugin) {
  Service.call(this, def, configuration, plugin);
}
NodeService.prototype = {
  constructor: NodeService,
  __proto__:  Service.prototype,
  
  loadImplementation(dynamicallyCreated, location) {
    if (dynamicallyCreated) {
      const nodeModule = requireFromString(this.source);
      this.nodeModule = nodeModule;
    } else {
      // Quick fix before MVD-947 is merged
      var fileLocation = ""
      if (this.filename) {
        fileLocation = path.join(location, 'lib', this.filename);
      } else if (this.fileName) {
        fileLocation = path.join(location, 'lib', this.fileName);
      } else {
        throw new Error(`No file name for data service`)
      }
      const nodeModule = require(fileLocation);
      this.nodeModule = nodeModule;
    }
  }
}

//first checks if the parent plugin has a host and port 
//and if not, looks them up in the config
function ExternalService(def, configuration, plugin) {
  Service.call(this, def, configuration, plugin);
  if (!this.host) {
    this.host = plugin.host;
  }
  if (!this.port) {
    this.port = plugin.port;
  }
  const remoteConfig = configuration.getContents(["remote.json"]);
  if (remoteConfig) {
    if (!this.host) {
      this.host = remoteConfig.host;
    }
    if (!this.port) {
      this.port = remoteConfig.port;
    }
  }
}
ExternalService.prototype = {
  constructor: ExternalService,
  __proto__:  Service.prototype
}

function makeDataService(def, plugin, context) {
  const configuration = configService.getServiceConfiguration(plugin.identifier,
      def.name, context.config, context.productCode);
  let dataservice;
  if (def.type == "external") {
    dataservice = new ExternalService(def, configuration, plugin);
  } else if (def.type == "import") {
    dataservice = new Import(def, configuration, plugin);
  } else if ((def.type == 'nodeService')
        || (def.type === 'router')) {
    dataservice = new NodeService(def, configuration, plugin);
  } else {
    dataservice = new Service(def, configuration, plugin);
  }
  dataservice.validate();
  return dataservice;
}

function Plugin(def, configuration) {
  Object.assign(this, def);
  this.configuration = configuration;
  if (!this.location) {
    this.location = process.cwd();
  }
}
Plugin.prototype = {
  constructor: Plugin,
  identifier: null,
  apiVersion: null,
  pluginVersion: null,
  pluginType: null,
  webContent: null,
  location: null,
  dataServices: null,
  dataServicesGrouped: null,
  configuration: null,
  //...
  
  toString() {
    return `[Plugin ${this.identifier}]`
  },
  
  isValid() {
    //TODO detailed diagnostics
    return this.identifier && (typeof this.identifier === "string")
      && this.pluginVersion && (typeof this.pluginVersion === "string")
      && this.apiVersion && (typeof this.apiVersion === "string")
      //this might cause some pain, but I guess it's better to
      //leave it here and make everyone tidy up their plugin defs:
      && this.pluginType && (typeof this.pluginType === "string")
      ;
  },
  
  init(context) {
    bootstrapLogger.warn(this.identifier
        + `: "${this.pluginType}" plugins not yet implemented`);
  },
  
  exportDef() {
    return {
      identifier: this.identifier,
      pluginVersion: this.pluginVersion,
      apiVersion: this.apiVersion,
      pluginType: this.pluginType,
      //TODO move these to the appropraite plugin type(s)
      webContent: this.webContent, 
      configurationData: this.configurationData,
      dataServices: this.dataServices
    };
  },
  
  initStaticWebDependencies() {
    if (this.webContent) {
      let contentPath = path.join(this.location, "web");
      if (!fs.existsSync(contentPath)) {
        bootstrapLogger.warn(`plugin ${this.identifier} has web content but `
            + `no web directory under ${this.location}`);
      } else {
        bootstrapLogger.info(`plugin ${this.identifier} `
            + `will serve static files from ${contentPath}`);
        this.webContent.path = contentPath;
      }
    }
  },
  
  initDataServices(context) {
    function addService(service, name, container) {
      let group = container[name];
      if (!group) {
        group = container[name] = {
          highestVersion: null,
          versions: {},
        };
      }
      if (!group.highestVersion 
          || semver.gt(service.version, group.highestVersion)) {
        group.highestVersion = service.version;
      }
      group.versions[service.version] = service;
    }
    
    if (!this.dataServices) {
      return;
    }
    this.dataServicesGrouped = {};
    this.importsGrouped = {};
    const filteredDataServices = [];
    for (const dataServiceDef of this.dataServices) {
      const dataservice = makeDataService(dataServiceDef, this, context);
      if (dataservice.type == "service") {          
        addService(dataservice, dataservice.name, this.dataServicesGrouped);
        bootstrapLogger.info(`${this.identifier}: `
            + `found proxied service '${dataservice.name}'`);
        filteredDataServices.push(dataservice);
      } else   if (dataservice.type === 'import') {
        bootstrapLogger.info(`${this.identifier}:`
            + ` importing service '${dataservice.sourceName}'`
            + ` from ${dataservice.sourcePlugin}`
            + ` as '${dataservice.localName}'`);
        addService(dataservice, dataservice.localName, this.importsGrouped);
        filteredDataServices.push(dataservice);
      } else if ((dataservice.type == 'nodeService')
          || (dataservice.type === 'router')) {
        //TODO what is this? Why do we need it?
//        if ((dataservice.serviceLookupMethod == 'internal')
//            || !dataservice.dependenciesIncluded) {
//          bootstrapLogger.warn(`${this.identifier}:`
//              + ` loading dataservice ${dataservice.name} failed, declaration invalid`);
//          continue;
//        }
        dataservice.loadImplementation(this.dynamicallyCreated, this.location);
        if (dataservice.type === 'router') {
          bootstrapLogger.info(`${this.identifier}: `
              + `found router '${dataservice.name}'`);
          addService(dataservice, dataservice.name, this.dataServicesGrouped);
        } else {
          bootstrapLogger.info(`${this.identifier}: `
              + `found legacy node service '${dataservice.name}'`);
          addService(dataservice, dataservice.name, this.dataServicesGrouped);
        }
        filteredDataServices.push(dataservice);
      } else if (dataservice.type == 'external') {
        addService(dataservice, dataservice.name, this.dataServicesGrouped);
        bootstrapLogger.info(`${this.identifier}: `
            + `found external service '${dataservice.name}'`);
        filteredDataServices.push(dataservice);
      } else {
        bootstrapLogger.warn(`${this.identifier}: `
            + `invalid service type '${dataservice.name}'`);
      }
    }
    this.dataServices = filteredDataServices;
  }
};

function LibraryPlugIn(def, configuration) {
  Plugin.call(this, def, configuration);
}
LibraryPlugIn.prototype = {
  __proto__: Plugin.prototype,
  constructor: LibraryPlugIn,
  
  init(context) {
    assert(this.pluginType === "library");
    if (!fs.existsSync(this.location)) {
      bootstrapLogger.log(bootstrapLogger.WARNING,
        `${def.identifier}: library path ${this.location} does not exist`);
      return;
    }
    bootstrapLogger.log(bootstrapLogger.INFO,
      `Plugin ${this.identifier} will serve library data from directory ${this.location}`);
  }
};

function ApplicationPlugIn(def, configuration) {
  Plugin.call(this, def, configuration);
}
ApplicationPlugIn.prototype = {
  __proto__: Plugin.prototype,
  constructor: ApplicationPlugIn,
};

function WindowManagerPlugIn(def, configuration) {
  Plugin.call(this, def, configuration);
}
WindowManagerPlugIn.prototype = {
  constructor: WindowManagerPlugIn,
  __proto__: Plugin.prototype,
};

function BootstrapPlugIn(def, configuration) {
  Plugin.call(this, def, configuration);
}
BootstrapPlugIn.prototype = {
  constructor: BootstrapPlugIn,
  __proto__: Plugin.prototype,
};

function DesktopPlugIn(def, configuration) {
  Plugin.call(this, def, configuration);
}
DesktopPlugIn.prototype = {
  constructor: DesktopPlugIn,
  __proto__: Plugin.prototype,
};

function NodeAuthenticationPlugIn(def, configuration) {
  Plugin.call(this, def, configuration);
}
NodeAuthenticationPlugIn.prototype = {
  constructor: NodeAuthenticationPlugIn,
  __proto__: Plugin.prototype,
  authenticationCategory: null,
  filename: null,
  
  isValid(context) {
    if (!(super.isValid(context) && this.filename 
        && this.authenticationCategory)) {
      return false;
    }
    //we should not load authentication types that are 
    //not requested by the administrator
    if (!context.authManager.authPluginRequested(this.identifier,
      this.authenticationCategory)) {
      bootstrapLogger.warn("Authentication plugin was found which was not requested in "
          + "the server configuration file's dataserviceAuthentication object. "
          + "Skipping load of this plugin");
      return false;
    }
    return true;
  },
  
  exportDef() {
    return Object.assign(super.exportDef(), {
      filename: this.filename,
      authenticationCategory: this.authenticationCategory
    });
  },
  
  init(context) {
    const filepath = path.join(this.location, 'lib', this.filename);
    bootstrapLogger.log(bootstrapLogger.INFO,
      `Auth plugin ${this.identifier}: loading auth handler module ${filepath}`)
    this.authenticationModule = require(filepath);
    context.authManager.registerAuthenticator(this);
  }
};

function ProxyConnectorPlugIn(def, configuration) {
  Plugin.call(this, def, configuration);
  const remoteConfig = configuration.getContents(["remote.json"]);
  if (remoteConfig) {
    if (!this.host) {
      this.host = remoteConfig.host;
    }
    if (!this.port) {
      this.host = remoteConfig.port;
    }
  }
}
ProxyConnectorPlugIn.prototype = {
  constructor: ProxyConnectorPlugIn,
  __proto__: Plugin.prototype,
  
  isValid(context) {
    if (!(super.isValid(context) && this.host && this.port)) {
      return false;
    }
    //we should not load authentication types that are 
    //not requested by the administrator
    if (!context.authManager.authPluginRequested(this.identifier,
      this.authenticationCategory)) {
      bootstrapLogger.warn("Authentication plugin was found which was not requested in "
          + "the server configuration file's dataserviceAuthentication object. "
          + "Skipping load of this plugin");
      return false;
    }
    return true;
  },
};

const plugInConstructorsByType = {
  "library": LibraryPlugIn,
  "application": ApplicationPlugIn,
  "windowManager": WindowManagerPlugIn,
  "bootstrap": BootstrapPlugIn,
  "desktop": DesktopPlugIn,
  "nodeAuthentication": NodeAuthenticationPlugIn,
  "proxyConnector": ProxyConnectorPlugIn
};

function makePlugin(def, pluginConfiguration) {
  const pluginConstr = plugInConstructorsByType[def.pluginType];
  if (!pluginConstr) {
    throw new Error(`${def.identifier}: pluginType ${def.pluginType} is unknown`); 
  }
  // one can think in terms of Java: `def` is a JSON-serialized instance of the
  // "class" referred to by `proto`. Create an instance and inject the
  // de-serialized instance data there.
  // (We don't need an extra indirection level, e.g. self.definition = def)
  const self = new pluginConstr(def, pluginConfiguration);
  return self;
};

function PluginLoader(options) {
  EventEmitter.call(this);
  this.options = zluxUtil.makeOptionsObject(defaultOptions, options);
  this.ng2 = null;
  this.plugins = [];
  this.pluginMap = {};
};
PluginLoader.prototype = {
  constructor: PluginLoader,
  __proto__: EventEmitter.prototype,
  options: null,
  ng2: null,
  plugins: null,
  pluginMap: null,

  _readPluginDef(pluginDescriptorFilename) {
    const pluginPtrPath = path.join(this.options.pluginsDir, 
        pluginDescriptorFilename);
    bootstrapLogger.info(`Processing plugin reference ${pluginPtrPath}...`);
    if (!fs.existsSync(pluginPtrPath)) {
      throw new Error(`${pluginPtrPath} is missing`);
    }
    const pluginPtrDef = jsonUtils.parseJSONWithComments(pluginPtrPath);
    bootstrapLogger.log(bootstrapLogger.FINER, util.inspect(pluginPtrDef));
    let pluginBasePath = pluginPtrDef.pluginLocation;
    if (!fs.existsSync(pluginBasePath)) {
      throw new Error(`${pluginDescriptorFilename}: No plugin directory found at`
        + `${pluginPtrDef.pluginLocation}`);
     }
    let pluginDefPath = path.join(pluginBasePath, 'pluginDefinition.json');
    if (!fs.existsSync(pluginDefPath)) {
      throw new Error(`${pluginDescriptorFilename}: No pluginDefinition.json `
          + `found at ${pluginBasePath}`);
    }
    let pluginDef = jsonUtils.parseJSONWithComments(pluginDefPath);
    bootstrapLogger.log(bootstrapLogger.FINER,util.inspect(pluginDef));
    if (pluginDef.identifier !== pluginPtrDef.identifier) {
      throw new Error(`${pluginDef.identifier} and ${pluginPtrDef.identifier} `
          + `don't match - plugin ignored`);
    }
    if (!pluginDef.pluginType) {
      throw new Error(`No plugin type found for ${pluginDef.identifier} `
      + `found at ${pluginBasePath}, skipping`)
    }
    bootstrapLogger.info(`Read ${pluginBasePath}: found plugin type `
        + `'${pluginDef.pluginType}'`);
    pluginDef.location = pluginBasePath;
    return pluginDef;
  },

  _generateNg2ModuleTs(plugins) {
    let importStmts = [];
    let modules = ["BrowserModule"];
    plugins.filter(function(def) {
      return def.webContent && 
        ("object" === typeof def.webContent) &&
        (def.webContent.framework === "angular2");
    }).forEach(function (def) {
      let ng2ModuleName = def.webContent.ng2ModuleName;
      let ng2ModuleLocation = def.webContent.ng2ModuleLocation;
      if (!(ng2ModuleName && ng2ModuleLocation)) {
        bootstrapLogger.warn(`Invalid NG2 module: ${def.location}: `
            + "'ng2ModuleName' or 'ng2ModuleLocation' missing");
        return;
      } 
      importStmts.push("import { "+ng2ModuleName+" } from '"+ng2ModuleLocation+"';\n");
      modules.push(ng2ModuleName);
    });
    let ng2 = 
        "import { NgModule } from '@angular/core';\n"+
        "import { BrowserModule } from '@angular/platform-browser';\n"+
        importStmts.join("") +
        "@NgModule({\n"+
        "  imports: ["+modules.join(", ")+"]\n" +
        "})\n" +
        "export class Ng2RootModule {}\n";
    bootstrapLogger.log(bootstrapLogger.FINER,
      "Generated ng2 module:\n" + ng2);
    return ng2;
  },
  
  readPluginDefs() {
    const defs = [];
    bootstrapLogger.log(bootstrapLogger.INFO,
      `Reading plugins dir ${this.options.pluginsDir}`);
    const pluginLocationJSONs = fs.readdirSync(this.options.pluginsDir)
      .filter(function(value){
        return value.match(/.*\.json/);
      });
    bootstrapLogger.log(bootstrapLogger.FINER, util.inspect(pluginLocationJSONs));
    for (const pluginDescriptorFilename of pluginLocationJSONs) {
      try {
        const plugin = this._readPluginDef(pluginDescriptorFilename);
        defs.push(plugin);
      } catch (e) {
        console.log(e);
        bootstrapLogger.warn(e)
        bootstrapLogger.log(bootstrapLogger.INFO,
          `Failed to load ${pluginDescriptorFilename}\n`);
      }
    } 
    return defs;
  },
  
  loadPlugins() {
    const defs = this.readPluginDefs();
    this.installPlugins(defs);
  },
  
  installPlugins(pluginDefs) {
    const pluginContext = {
      productCode: this.options.productCode,
      config: this.options.serverConfig,
      authManager: this.options.authManager
    };
    let successCount = 0;
    const depgraph = new DependencyGraph(this.plugins);
    for (const pluginDef of pluginDefs) {
      depgraph.addPlugin(pluginDef);
    }
    const sortedAndRejectedPlugins = depgraph.processImports();
    for (const rejectedPlugin of sortedAndRejectedPlugins.rejects) {
      bootstrapLogger.warn(`Could not initialize plugin` 
          + ` ${rejectedPlugin.pluginId}: `  
          + rejectedPlugin.validationError.status);
    }
    for (const pluginDef of sortedAndRejectedPlugins.plugins) { 
      try {
        const pluginConfiguration = configService.getPluginConfiguration(
            pluginDef.identifier, this.options.serverConfig,
            this.options.productCode);
        bootstrapLogger.debug(`For plugin with id=${pluginDef.identifier}, internal config` 
                                + ` found=\n${JSON.stringify(pluginConfiguration)}`);
        const plugin = makePlugin(pluginDef, pluginConfiguration);
        if (!plugin.isValid(pluginContext)) {
          bootstrapLogger.warn(`${pluginDef.location} points to an`
              + " invalid plugin definition, skipping");
          continue;
        }
        plugin.initDataServices(pluginContext);
        plugin.initStaticWebDependencies();
        plugin.init(pluginContext);
        bootstrapLogger.log(bootstrapLogger.INFO,
            `Plugin ${plugin.identifier} at path=${plugin.location} loaded.\n`);
        bootstrapLogger.debug(' Content:\n' + plugin.toString());
        this.plugins.push(zluxUtil.deepFreeze(plugin));
        this.pluginMap[plugin.identifier] = plugin;
        successCount++;
      } catch (e) {
        console.log(e);
        //bootstrapLogger.warn(e)
        bootstrapLogger.log(bootstrapLogger.INFO,
          `Failed to load ${pluginDef.identifier}: ${e}`);
      }
    }
    bootstrapLogger.info(`Plugin batch processed. Loaded ${successCount} out of`
        + ` ${pluginDefs.length}`);
    // FIXME (1) 'give plugin amount' is not an event -- not something that _happens_
    // (2) this idea is incompatible with dynamic plugins, they're broken now. 
    // Need to come up with another event scheme, e.g. 'pluginAdded' + 
    // 'fileSystemPluginsLoaded', or maybe 'pluginAdded' + 'processingPluginBatchCompeleted',
    // or 'startedProcessingPluginBatch' + 'pluginAdded', etc, if we want to 
    // distinguish between filesystem and dynamic plugins or if we just need to 
    // have a reference point in time, when a subscriber can know it can call 
    // e.g. Eureka
    this.emit('givePluginAmount', {
      data: this.plugins.length
    });  
    for (const plugin of this.plugins) {
      this.emit('pluginAdded', {
        data: plugin
      });
    }
  },
  
  addDynamicPlugin(pluginDef) {
    if (this.pluginMap[pluginDef.identifier]) {
      throw new Error('plugin already registered');
    }
    const pluginContext = {
      productCode: this.options.productCode,
      config: this.options.serverConfig,
      plugins: this.plugins,
      authManager: this.options.authManager
    };
    //
    //TODO resolving dependencies correctly
    //see also: the FIXME note at the end of installPlugins()
    //
    bootstrapLogger.info("Adding dynamic plugin " + pluginDef.identifier);
    const pluginConfiguration = configService.getPluginConfiguration(
      pluginDef.identifier, this.options.serverConfig,
      this.options.productCode);
    const plugin = makePlugin(pluginDef, pluginConfiguration);
    plugin.dynamicallyCreated = true; /* TODO extra security */
    plugin.initDataServices(pluginContext);
    plugin.init(pluginContext);
//    if (!this.unresolvedImports.allImportsResolved(pluginContext.plugins)) {
//      throw new Error('unresolved dependencies');
//      this.unresolvedImports.reset();
//    }
    zluxUtil.deepFreeze(plugin);
    this.plugins.push(plugin);
    this.pluginMap[plugin.identifier] = plugin;
    this.emit('pluginAdded', {
      data: plugin
    });
  }
};

module.exports = PluginLoader;

const _unitTest = false;
function unitTest() {
  var configData = {
  "zssPort":31338,
// All paths relative to ZLUX/node or ZLUX/bin
// In real installations, these values will be configured during the install.
  "rootDir":"../deploy",
  "productDir":"../deploy/product",
  "siteDir":"../deploy/site",
  "instanceDir":"../deploy/instance",
  "groupsDir":"../deploy/instance/groups",
  "usersDir":"../deploy/instance/users",
  "pluginsDir":"../deploy/instance/ZLUX/plugins",

  "productCode": 'ZLUX',
  "dataserviceAuthentication": {
    //this specifies the default authentication type for dataservices that didn't specify which type to use. These dataservices therefore should not expect a particular type of authentication to be used.
    "defaultAuthentication": "fallback",
    
    //each authentication type may have more than one implementing plugin. define defaults and fallbacks below as well
    //any types that have no implementers are ignored, and any implementations specified here that are not known to the server are also ignored.
    "implementationDefaults": {
      //each type has an object which describes which implementation to use based on some criteria to find which is best for the task. For now, just "plugins" will
      //be used to state that you want a particular plugin.
      "fallback": {
        "plugins": ["com.rs.auth.trivialAuth"]
      }
    }
  }  
  };
  var pm = new PluginLoader(configData, process.cwd());
  var pl = pm.loadPlugins();
  console.log("plugins: ", pl);
  //console.log(pl.ng2)
}
if (_unitTest) {
  unitTest()
}

/*
  This program and the accompanying materials are
  made available under the terms of the Eclipse Public License v2.0 which accompanies
  this distribution, and is available at https://www.eclipse.org/legal/epl-v20.html
  
  SPDX-License-Identifier: EPL-2.0
  
  Copyright Contributors to the Zowe Project.
*/

