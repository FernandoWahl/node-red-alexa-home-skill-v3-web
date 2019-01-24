// Express Router ============================
var express = require('express');
var router = express.Router();
var bodyParser = require('body-parser');
router.use(bodyParser.urlencoded({ extended: true }));
router.use(bodyParser.json());
// ===========================================
// Request =======================
const request = require('request');
// ===============================
// Schema =======================
var Account = require('../models/account');
var oauthModels = require('../models/oauth');
var Devices = require('../models/devices');
var Topics = require('../models/topics');
var LostPassword = require('../models/lostPassword');
// ===============================
// Auth Handler ==============================
var passport = require('passport');
var BasicStrategy = require('passport-http').BasicStrategy;
var LocalStrategy = require('passport-local').Strategy;
var countries = require('countries-api');
var PassportOAuthBearer = require('passport-http-bearer');
var oauthServer = require('../oauth');
var url = require('url');
// ===========================================
// Winston Logger ============================
var logger = require('../config/logger');
var debug = (process.env.ALEXA_DEBUG || false);
// ===========================================
// Google Auth JSON Web Token ================
var gToken = undefined; // Store Report State OAuth Token
const jwt = require('jsonwebtoken');
const ghomeJWT = process.env['GHOMEJWT'];
var reportState = false;
var keys;
if (!ghomeJWT) {
	logger.log('warn', "[GHome API] JSON Web Token not supplied via ghomeJWT environment variable. Google Home Report State disabled.")
}
else {
	reportState = true;
	keys = JSON.parse(ghomeJWT);
}
// ===========================================
// Google Analytics ==========================
var ua = require('universal-analytics');
var enableAnalytics = false;
if (process.env.GOOGLE_ANALYTICS_TID != undefined) {
    enableAnalytics = true;
    var visitor = ua(process.env.GOOGLE_ANALYTICS_TID);
}
//=============================================
// Passport Config, Local *and* Oauth Support =
passport.use(new LocalStrategy(Account.authenticate()));
passport.use(new BasicStrategy(Account.authenticate()));
passport.serializeUser(Account.serializeUser());
passport.deserializeUser(Account.deserializeUser());
var accessTokenStrategy = new PassportOAuthBearer(function(token, done) {
	oauthModels.AccessToken.findOne({ token: token }).populate('user').populate('grant').exec(function(error, token) {
		if (!error && token && !token.grant) {
			logger.log('error', "[Core] Missing grant token:" + token);
		}
		if (!error && token && token.active && token.grant && token.grant.active && token.user) {
			logger.log('debug', "[Core] OAuth Token good, token:" + token);
			done(null, token.user, { scope: token.scope });
		} else if (!error) {
			logger.log('error', "[Core] OAuth Token error, token:" + token);
			done(null, false);
		} else {
			logger.log('error', "[Core] OAuth Token error:" + error);
			done(error);
		}
	});
});
passport.use(accessTokenStrategy);
//===========================================
// MQTT =====================================
var mqtt = require('mqtt');
//===========================================
// MQTT ENV variables========================
var mqtt_user = (process.env.MQTT_USER);
var mqtt_password = (process.env.MQTT_PASSWORD);
var mqtt_port = (process.env.MQTT_PORT || "1883");
var mqtt_url = (process.env.MQTT_URL || "mqtt://mosquitto:" + mqtt_port);
//===========================================
// MQTT Config ==============================
var mqttClient;
var mqttOptions = {
	connectTimeout: 30 * 1000,
	reconnectPeriod: 1000,
	keepAlive: 10,
	clean: true,
	resubscribe: true,
	clientId: 'gHomeAPI_' + Math.random().toString(16).substr(2, 8)
};
if (mqtt_user) {
	mqttOptions.username = mqtt_user;
	mqttOptions.password = mqtt_password;
}
logger.log('info', "[GHome API] Connecting to MQTT server: " + mqtt_url);
mqttClient = mqtt.connect(mqtt_url, mqttOptions);
mqttClient.on('error',function(err){
	logger.log('error', "[GHome API] MQTT connect error");
});
mqttClient.on('reconnect', function(){
	logger.log('warn', "[GHome API] MQTT reconnect event");
});
mqttClient.on('connect', function(){
	logger.log('info', "[GHome API] MQTT connected, subscribing to 'response/#'")
	mqttClient.subscribe('response/#');
	// logger.log('info', "[GHome API] MQTT connected, subscribing to 'state/#'")
	// mqttClient.subscribe('state/#');
});
//===========================================
// Redis Client =============================
var client = require('../config/redis')
// ==========================================
// Rate-limiter =============================
const limiter = require('express-limiter')(router, client)
// Default Limiter, used on majority of routers ex. OAuth2-related and Command API
const defaultLimiter = limiter({
	lookup: function(req, res, opts, next) {
		opts.lookup = 'connection.remoteAddress'
		opts.total = 100
		opts.expire = 1000 * 60 * 60
		return next()
  },
	onRateLimited: function (req, res, next) {
		logger.log('warn', "[Rate Limiter] Default rate-limit exceeded for path: " + req.path + ", IP address:" + req.ip)
		var params = {
			ec: "Express-limiter",
			ea: "Default: rate-limited path: " + req.path + ", IP address:" + req.ip,
			uip: req.ip
		  }
		if (enableAnalytics) {visitor.event(params).send()};
		res.status(429).json('Rate limit exceeded');
	  }
});
// ==========================================
// GHome Functions =========================
const gHomeFunc = require('../functions/func-ghome');
const sendState =  gHomeFunc.sendState;
const queryDeviceState = gHomeFunc.queryDeviceState;
const requestToken2 = gHomeFunc.requestToken2;
// const isGhomeUser = gHomeFunc.isGhomeUser;
// ==========================================

// Revised gToken variable assignment
requestToken2(keys, function(returnValue) {
	gToken = returnValue;
	logger.log('verbose', "[GHome API] Ghome JWT callback returned OAuth token:" + JSON.stringify(gToken));
});

// Refresh Google oAuth Token used for State Reporting
var refreshToken = setInterval(function(){
	requestToken2(keys, function(returnValue) {
		gToken = returnValue;
		logger.log('verbose', "[GHome API] Ghome JWT callback refreshed OAuth token:" + JSON.stringify(gToken));
	});
},3540000);

// ==========================================
// GHome Action API =========================
router.post('/action', defaultLimiter,
	passport.authenticate(['bearer', 'basic'], { session: false }),
	function(req,res,next){
	logger.log('verbose', "[GHome API] Request:" + JSON.stringify(req.body));
	var intent = req.body.inputs[0].intent;
	var requestId = req.body.requestId;

	switch (intent) {
		///////////////////////////////////////////////////////////////////////////
		case 'action.devices.SYNC' :
			logger.log('verbose', "[GHome Sync API] Running device discovery for user:" + req.user.username);
			var params = {
				ec: "SYNC",
				ea: "GHome SYNC event for username: " + req.user.username,
				uid: req.user.username,
				uip: req.ip,
				dp: "/api/v1/action"
			  }
			if (enableAnalytics) {visitor.event(params).send()};

			if (debug == "true") {console.time('ghome-sync')};
			var findUser = Account.find({username: req.user.username});
			var findDevices = Devices.find({username: req.user.username});
			Promise.all([findUser, findDevices]).then(([user, devices]) => {
				if (user && devices) {
					logger.log('debug', "[GHome Sync API] User: " + JSON.stringify(user[0]));
					logger.log('debug', "[GHome Sync API] Devices: " + JSON.stringify(devices));
					// Build Device Array
					var devs = [];
					for (var i=0; i< devices.length; i++) {
						var deviceJSON = JSON.parse(JSON.stringify(devices[i])); 
						var dev = {}
						dev.id = "" + devices[i].endpointId;
						dev.type = gHomeReplaceType(devices[i].displayCategories);
						dev.traits = [];
						// Check supported device type
						if (dev.type != "NA") {
							// Check supported capability/ trait
							devices[i].capabilities.forEach(function(capability){
								var trait = gHomeReplaceCapability(capability);
								// Add supported traits, don't add duplicates
								if (trait != "Not Supported" && dev.traits.indexOf(trait) == -1){
									dev.traits.push(trait);
								}
							});
						}
						dev.name = {
							name : devices[i].friendlyName
							}
						dev.willReportState = devices[i].reportState;
						dev.attributes = devices[i].attributes;
						// Populate attributes, remap roomHint to device root
						if (deviceJSON.hasOwnProperty('attributes')) {
							if (deviceJSON.attributes.hasOwnProperty('roomHint')){
								delete dev.attributes.roomHint;
								if (deviceJSON.attributes.roomHint != ""){dev.roomHint = deviceJSON.attributes.roomHint};
							}
						}
						// Add colorModel attribute if color is supported interface/ trait
						if (devices[i].capabilities.indexOf("ColorController") > -1 ){
							dev.attributes.colorModel = "hsv";
							delete dev.attributes.commandOnlyColorSetting; // defaults to false anyway
						}
						// Pass min/ max values as float
						if (devices[i].capabilities.indexOf("ColorTemperatureController") > -1 ){
							dev.attributes.colorTemperatureRange.temperatureMinK = parseInt(dev.attributes.colorTemperatureRange.temperatureMinK);
							dev.attributes.colorTemperatureRange.temperatureMaxK = parseInt(dev.attributes.colorTemperatureRange.temperatureMaxK);
						}

						// action.devices.traits.TemperatureSetting, adjust dev.attributes to suit Google Home
						if (dev.traits.indexOf("action.devices.traits.TemperatureSetting") > -1 ){
							//dev.attributes.availableThermostatModes = dev.attributes.thermostatModes.map(function(x){return x.toLowerCase()});
							dev.attributes.availableThermostatModes = dev.attributes.thermostatModes.join().toLowerCase(); // Make string, not array
							dev.attributes.thermostatTemperatureUnit = dev.attributes.temperatureScale.substring(0, 1); // >> Need to make this upper F or C, so trim
							delete dev.attributes.temperatureRange;
							delete dev.attributes.temperatureScale;
							delete dev.attributes.thermostatModes;
						}
						dev.deviceInfo = {
							manufacturer : "Node-RED",
							model : "Node-RED",
							hwVersion : "0.1",
							swVersion : "0.1"
						}
						// Limit supported traits, don't add other device types
						if (dev.traits.length > 0 && dev.type != "NA") {
							devs.push(dev);
						}
					}

					// Build Response
					var response = {
						"requestId": requestId,
						"payload": {
							"agentUserId": user[0]._id,
							"devices" : devs
						}
					}
					logger.log('verbose', "[GHome Sync API] Discovery Response: " + JSON.stringify(response));
					// Send Response
					res.status(200).json(response);
					if (debug == "true") {console.timeEnd('ghome-sync')};
				}
				else if (!user){
					logger.log('warn', "[GHome Sync API] User not found");
					res.status(500).json({message: "User not found"});
					if (debug == "true") {console.timeEnd('ghome-sync')};
				}
				else if (!device) {
					logger.log('warn', "[GHome Sync API] Device not found");
					res.status(500).json({message: "Device not found"});
					if (debug == "true") {console.timeEnd('ghome-sync')};
				}
			}).catch(err => {
				logger.log('error', "[GHome Sync API] error:" + err)
				res.status(500).json({message: "An error occurred."});
				if (debug == "true") {console.timeEnd('ghome-sync')};
			});
			break;

		///////////////////////////////////////////////////////////////////////////
		case 'action.devices.EXECUTE' : 
			logger.log('verbose', "[GHome Exec API] Execute command for user:" + req.user.username);
			var params = {
				ec: "EXECUTE",
				ea: "GHome EXECUTE event for username: " + req.user.username,
				uid: req.user.username,
				uip: req.ip,
				dp: "/api/v1/action"
			  }
			if (enableAnalytics) {visitor.event(params).send()};

			if (debug == "true") {console.time('ghome-exec')};
			var findDevices = Devices.find({username: req.user.username});
			Promise.all([findDevices]).then(([devices]) => {
				if (devices) {
					var arrCommands = req.body.inputs[0].payload.commands; // Array of commands, assume match with device array at same index?!
					logger.log('debug', "[GHome Exec API] Returned mongodb devices typeof:" + typeof devices);
					//var devicesJSON = JSON.parse(JSON.stringify(devices));
					//logger.log('debug', "[GHome Exec API] User devices:" + JSON.stringify(devicesJSON));
					for (var i=0; i< arrCommands.length; i++) { // Iterate through commands in payload, against each listed 
						var arrCommandsDevices =  req.body.inputs[0].payload.commands[i].devices; // Array of devices to execute commands against
						var params = arrCommands[i].execution[0].params; // Google Home Parameters
						var validationStatus = true;
						// Match device to returned array in case of any required property/ validation
						arrCommandsDevices.forEach(function(element) {
							//logger.log('debug', "[GHome Exec API] Attempting to matching command device: " + element.id + ", against devicesJSON");
							var data = devices.find(obj => obj.endpointId == element.id);
							if (data == undefined) {logger.log('debug', "[GHome Exec API] Failed to match device against devicesJSON")}
							else {logger.log('debug', "[GHome Exec API] Executing command against device:" + JSON.stringify(data))}
							// Handle Thermostat valueOutOfRange
							if (arrCommands[i].execution[0].command == "action.devices.commands.ThermostatTemperatureSetpoint") {
								var hastemperatureMax = getSafe(() => data.attributes.temperatureRange.temperatureMax);
								var hastemperatureMin = getSafe(() => data.attributes.temperatureRange.temperatureMin);
								if (hastemperatureMin != undefined && hastemperatureMax != undefined) {
									var temperatureMin = data.attributes.temperatureRange.temperatureMin;
									var temperatureMax = data.attributes.temperatureRange.temperatureMax;
									logger.log('debug', "[GHome Exec API] Checking requested setpoint: " + params.thermostatTemperatureSetpoint + " , againast temperatureRange, temperatureMin:" + hastemperatureMin + ", temperatureMax:" + temperatureMax);
									if (params.thermostatTemperatureSetpoint > temperatureMax || params.thermostatTemperatureSetpoint < temperatureMin){
										// Build valueOutOfRange error response
										validationStatus = false;
										logger.log('warn', "[GHome Exec API] Temperature valueOutOfRange error for endpointId:" + element.id);
										// Global error response
										var errResponse = {
											"requestId": req.body.requestId,
											"payload": {
												"errorCode": "valueOutOfRange"
											}
										}
										logger.log('debug', "[GHome Exec API] valueOutOfRange error response:" + JSON.stringify(errResponse));
										res.status(200).json(errResponse);
									}
								}
							}
							// Handle Color Temperature valueOutOfRange
							if (arrCommands[i].execution[0].command == "action.devices.commands.ColorAbsolute") {
								var hastemperatureMaxK = getSafe(() => data.attributes.colorTemperatureRange.temperatureMaxK);
								var hastemperatureMinK = getSafe(() => data.attributes.colorTemperatureRange.temperatureMinK);
								if (hastemperatureMinK != undefined && hastemperatureMaxK != undefined) {
									var temperatureMinK = data.attributes.colorTemperatureRange.temperatureMinK;
									var temperatureMaxK = data.attributes.colorTemperatureRange.temperatureMaxK;
									logger.log('debug', "[GHome Exec API] Checking requested setpoint: " + params.color.temperature + " , againast temperatureRange, temperatureMin:" + hastemperatureMin + ", temperatureMax:" + temperatureMax);
									if (params.color.temperature > temperatureMaxK || params.color.temperature < temperatureMinK){
										// Build valueOutOfRange error response
										validationStatus = false;
										logger.log('warn', "[GHome Exec API] valueOutOfRange error for endpointId:" + element.id);
										// Global error response
										var errResponse = {
											"requestId": req.body.requestId,
											"payload": {
												"errorCode": "valueOutOfRange"
											}
										}
										logger.log('debug', "[GHome Exec API] Color Temperature valueOutOfRange error response:" + JSON.stringify(errResponse));
										res.status(200).json(errResponse);
									}
								}
							}
							if (validationStatus == true) {
								logger.log('debug', "[GHome Exec API] Command to be executed against endpointId:" + element.id);
								// Set MQTT Topic
								var topic = "command/" + req.user.username + "/" + element.id;
								try{
									// Define MQTT Message
									var message = JSON.stringify({
										requestId: requestId,
										id: element.id,
										execution: arrCommands[i]
									});
									mqttClient.publish(topic,message); // Publish Command
									logger.log('verbose', "[GHome Exec API] Published MQTT command for user: " + req.user.username + " topic: " + topic);
									logger.log('debug', "[GHome Exec API] MQTT message:" + message);

								} catch (err) {
									logger.log('warn', "[GHome Exec API] Failed to publish MQTT command for user: " + req.user.username);
									logger.log('debug', "[GHome Exec API] Publish MQTT command error: " + err);
								}
								// Build success response and include in onGoingCommands
								var response = {
									requestId: requestId,
									payload: {
										commands: [{
											ids: [element.id],
											status: "SUCCESS",
											state: params
										}]
									}
								}
								var command = {
									user: req.user.username,
									userId: req.user._id,
									requestId: requestId,
									res: res,
									response: response,
									source: "Google",
									timestamp: Date.now()
								};
								onGoingCommands[requestId] = command; // Command drops into buffer w/ 6000ms timeout (see defined funcitonm above) - ACK comes from N/R flow
							}
						});
					}
					if (debug == "true") {console.timeEnd('ghome-exec')};
				}
				else if (!device) {
					logger.log('warn', "[GHome Exec API] Device not found");
					res.status(500).json({message: "Device not found"});
					if (debug == "true") {console.timeEnd('ghome-exec')};
				}
			}).catch(err => {
				logger.log('error', "[GHome Exec API] error:" + err)
				res.status(500).json({message: "An error occurred."});
				if (debug == "true") {console.timeEnd('ghome-exec')};
			});

			break;

		///////////////////////////////////////////////////////////////////////////
		case 'action.devices.QUERY' :
			logger.log('verbose', "[GHome Query API] Running device state query for user:" + req.user.username);

			var params = {
				ec: "QUERY",
				ea: "GHome QUERY event for username: " + req.user.username,
				uid: req.user.username,
				uip: req.ip,
				dp: "/api/v1/action"
			  }
			if (enableAnalytics) {visitor.event(params).send()};

			if (debug == "true") {console.time('ghome-query')};





			var findUser = Account.find({username: req.user.username});
			var findDevices = Devices.find({username: req.user.username});
			Promise.all([findUser, findDevices]).then(([user, devices]) => {
				if (user && devices) {
					var arrQueryDevices = req.body.inputs[0].payload.devices;
						// Create JSON object
							// var response = {
							// 	"requestId": requestId,
							// 	"payload": {
							// 		"devices" : {}
							// 	}
							// }
						
						// For each device in arrQueryDevices
							// Build a state response
							// Call function to add to response

						// When iterated through arrayu and populated response array ion JSON object
						// Send response as call back

						var response = {
							"requestId": requestId,
							"payload": {
								"devices" : {}
							}
						}
						asyncForEach(arrQueryDevices, async (dev) => {
							var data = devices.find(obj => obj.endpointId == dev.id);
							if (data) {
								await queryDeviceState(data, function(state) {
									if (response != undefined) {
										response.payload.devices[data.endpointId] = state;
									}
								});
							}
							else {
								logger.log('warn', "[GHome Query API] Unable to match a requested device with user endpointId");
							}
						})

						// Send Response
						logger.log('verbose', "[GHome Query API] QUERY state: " + JSON.stringify(response));
						res.status(200).json(response);
						if (debug == "true") {console.timeEnd('ghome-query')};

/* 					for (var i=0; i< arrQueryDevices.length; i++) {
						// Find device in array of user devices returned in promise
						logger.log('debug', "[GHome Query API] Trying to match requested device: " + arrQueryDevices[i].id + " with user-owned endpointId");	
						var data = devices.find(obj => obj.endpointId == arrQueryDevices[i].id);
						if (data) {
							logger.log('verbose', "[GHome Query API] Matched requested device: " + arrQueryDevices[i].id + " with user-owned endpointId: " + data.endpointId);	
							try {
								queryDeviceState(device, function(response) {
									if (response != undefined) {
										response.payload.devices[data.endpointId] = reponse;
									}
								});
							}
							catch (e) {logger.log('debug', "[GHome Query API] queryDeviceState error: " + e)}
						}
						else {
							logger.log('warn', "[GHome Query API] Unable to match a requested device with user endpointId");
						}
					} */
					// callback response
				}
				else if (!user){
					logger.log('warn', "[GHome Query API] User not found");
					res.status(500).json({message: "User not found"});
					if (debug == "true") {console.timeEnd('ghome-query')};
				}
				else if (!device) {
					logger.log('warn', "[GHome Query API] Device not found");
					res.status(500).json({message: "Device not found"});
					if (debug == "true") {console.timeEnd('ghome-query')};
				}

			}).catch(err => {
				logger.log('error', "[GHome Query API] error:" + err)
				res.status(500).json({message: "An error occurred."});
				if (debug == "true") {console.timeEnd('ghome-query')};
			});
			break;

		///////////////////////////////////////////////////////////////////////////
		case 'action.devices.DISCONNECT' : 
			// Find service definition with Google URLs
			var userId = req.user._id;
			var params = {
				ec: "DISCONNECT",
				ea: "GHome Disconnect event for username: " + req.user.username,
				uid: req.user.username,
				uip: req.ip,
				dp: "/api/v1/action"
			  }
			if (enableAnalytics) {visitor.event(params).send()};

			oauthModels.Application.findOne({domains: "oauth-redirect.googleusercontent.com" },function(err, data){
				if (data) {
					// Remove OAuth tokens for **Google Home** only
					logger.log('debug', "[GHome Disconnect API] Disconnect request for userId:" + userId + ", application:" + data.title);
					var grantCodes = oauthModels.GrantCode.deleteMany({user: userId, application: data._id});
					var accessTokens = oauthModels.AccessToken.deleteMany({user: userId, application: data._id});
					var refreshTokens = oauthModels.RefreshToken.deleteMany({user: userId, application: data._id});
					Promise.all([grantCodes, accessTokens, refreshTokens]).then(result => {
						logger.log('info', "[GHome Disconnect API] Deleted GrantCodes, RefreshToken and AccessTokens for user account: " + userId)
						res.status(200).send();
					}).catch(err => {
					 	logger.log('warn', "[GHome Disconnect API] Failed to delete GrantCodes, RefreshToken and AccessTokens for user account: " + userId);
					 	res.status(500).json({error: err});
					});
				}
			});
			break; 
	}
});

// Convert Alexa Device Capabilities to Google Home-compatible
function gHomeReplaceCapability(capability) {
	// Limit supported traits, add new ones here
	if(capability == "PowerController") {return "action.devices.traits.OnOff"}
	else if(capability == "BrightnessController")  {return "action.devices.traits.Brightness"}
	else if(capability == "ColorController" || capability == "ColorTemperatureController"){return "action.devices.traits.ColorSetting"}
	else if(capability == "SceneController") {return "action.devices.traits.Scene"}
	else if(capability == "ThermostatController")  {return "action.devices.traits.TemperatureSetting"}
	else {return "Not Supported"}
}

// Convert Alexa Device Types to Google Home-compatible
function gHomeReplaceType(type) {
	// Limit supported device types, add new ones here
	if (type == "ACTIVITY_TRIGGER") {return "action.devices.types.SCENE"}
	else if (type == "LIGHT") {return "action.devices.types.LIGHT"}
	else if (type == "SMARTPLUG") {return "action.devices.types.OUTLET"}
	else if (type == "SWITCH") {return "action.devices.types.SWITCH"}
	else if (type.indexOf('THERMOSTAT') > -1) {return "action.devices.types.THERMOSTAT"}
	else {return "NA"}
}
/////////////////////// End GHome


///////////////////////////////////////////////////////////////////////////
// MQTT Message Handlers
///////////////////////////////////////////////////////////////////////////
var onGoingCommands = {};

// Event handler for received MQTT messages - note subscribe near top of script.
mqttClient.on('message',function(topic,message){
	var arrTopic = topic.split("/"); 
	var username = arrTopic[1];
	var endpointId = arrTopic[2];

	if (topic.startsWith('response/')){
		logger.log('info', "[Command API] Acknowledged MQTT response message for topic: " + topic);
		if (debug == "true") {console.time('mqtt-response')};
		var payload = JSON.parse(message.toString());
		//console.log("response payload", payload)
		var commandWaiting = onGoingCommands[payload.messageId];
		if (commandWaiting) {
			//console.log("mqtt response: " + JSON.stringify(payload,null," "));
			if (payload.success) {
				// Google Home success response
				if (commandWaiting.hasOwnProperty('source') && commandWaiting.source == "Google") {
					logger.log('debug', "[Command API] Successful Google Home MQTT command, response: " + JSON.stringify(commandWaiting.response));
					commandWaiting.res.status(200).json(commandWaiting.response);
					// Generate state JSON object and send to HomeGraph API
					if (reportState == true) {
						var pDevice = Devices.findOne({username: username, endpointId: endpointId});
						Promise.all([pDevice]).then(([device]) => {
							try {
								queryDeviceState(device, function(response) {
									if (response != undefined) {
										var stateReport = {
											"requestId" : commandWaiting.requestId,
											"agentUserId": commandWaiting.userId,
											"payload": {
												"devices" : {
													"states": {}
												}
											}
										}
										stateReport.payload.devices.states[device.endpointId] = response;

										if (gToken != undefined) {
											logger.log('verbose', '[GHome Report State] Calling Send State with gToken:' + JSON.stringify(gToken));
											sendState(gToken, stateReport);
										}
										else {logger.log('verbose', '[GHome Report State] Unable to call Send State, no token, gToken value:' + JSON.stringify(gToken))}
									}
								});							
							}
							catch (e) {logger.log('debug', "[GHome Query API] queryDeviceState error: " + e)}
						});
					}
				}		
			} else {
				// Google Home failure response
				if (commandWaiting.hasOwnProperty('source') && commandWaiting.source == "Google") {
					delete commandWaiting.response.state;
					commandWaiting.response.status = "FAILED";
					logger.log('warn', "[Command API] Failed Google Home MQTT command, response: " + JSON.stringify(commandWaiting.response));
					commandWaiting.res.status(200).json(commandWaiting.response);
				}
			}
			delete onGoingCommands[payload.messageId];
			var params = {
				ec: "Command",
				ea: "Command API successfully processed MQTT command for username: " + username,
				uid: username,
			  }
			if (enableAnalytics) {visitor.event(params).send()};
		}
		if (debug == "true") {console.timeEnd('mqtt-response')};
	}
	// Leave Alexa API MQTT state listener to pickup all other MQTT state messages
});

// Interval funciton, runs every 500ms once defined via setInterval: https://www.w3schools.com/js/js_timing.asp
var timeout = setInterval(function(){
	var now = Date.now();
	var keys = Object.keys(onGoingCommands);
	for (key in keys){
		var waiting = onGoingCommands[keys[key]];
		logger.log('debug', "[MQTT] Queued MQTT message: " + keys[key]);
		if (waiting) {
			var diff = now - waiting.timestamp;
			if (diff > 6000) {
				logger.log('warn', "[MQTT] MQTT command timed out/ unacknowledged: " + keys[key]);
				waiting.res.status(504).send('{"error": "timeout"}');
				delete onGoingCommands[keys[key]];
				//measurement.send({
				//	t:'event', 
				//	ec:'command', 
				//	ea: 'timeout',
				//	uid: waiting.user
				//});
			}
		}
	}
},500);

// Nested attribute/ element tester
function getSafe(fn) {
	try {
		return fn();
    } catch (e) {
        return undefined;
    }
}

async function asyncForEach(array, callback) {
	for (let index = 0; index < array.length; index++) {
	  await callback(array[index], index, array);
	}
  }

module.exports = router;