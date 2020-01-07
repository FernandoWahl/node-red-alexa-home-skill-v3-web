///////////////////////////////////////////////////////////////////////////
// Depends
///////////////////////////////////////////////////////////////////////////
const express = require('express');
const router = express.Router();
const bodyParser = require('body-parser');
router.use(bodyParser.urlencoded({ extended: true }));
router.use(bodyParser.json());
const Account = require('../models/account');
const oauthModels = require('../models/oauth');
const Devices = require('../models/devices');
const Topics = require('../models/topics');
// const passport = require('passport');
// const BasicStrategy = require('passport-http').BasicStrategy;
// const LocalStrategy = require('passport-local').Strategy;
//var countries = require('countries-api');
const logger = require('../loaders/logger');
const defaultLimiter = require('../loaders/limiter').defaultLimiter;
//const restrictiveLimiter = require('../loaders/limiter').restrictiveLimiter;
//const sendPageView = require('../services/ganalytics').sendPageView;
const sendPageViewUid = require('../services/ganalytics').sendPageViewUid;
//const sendEventUid = require('../services/ganalytics').sendEventUid;
///////////////////////////////////////////////////////////////////////////W
// Variables
///////////////////////////////////////////////////////////////////////////
// MQTT Settings  =========================================
const mqtt_user = (process.env.MQTT_USER);
///////////////////////////////////////////////////////////////////////////
// Passport Configuration
///////////////////////////////////////////////////////////////////////////
// passport.use(new LocalStrategy(Account.authenticate()));
// passport.use(new BasicStrategy(Account.authenticate()));
// passport.serializeUser(Account.serializeUser());
// passport.deserializeUser(Account.deserializeUser());
///////////////////////////////////////////////////////////////////////////
// Services
///////////////////////////////////////////////////////////////////////////
router.get('/services', defaultLimiter,
	ensureAuthenticated,
	async (req, res) => {
		try {
			if (req.user.superuser === true) {
				sendPageViewUid(req.path, 'Services Admin', req.ip, req.user.username, req.headers['user-agent']);
				let apps = await oauthModels.Application.find({});
				res.render('pages/services',{user:req.user, services: apps, brand: process.env.BRAND, title: "OAuth Services | " + process.env.BRAND});
			} else {
				res.redirect(303, '/');
			}
		}
		catch(e){
			logger.log('error' , "[Admin Services] Error rendering page, error: " + e.stack);
			res.status(500).send('Error rendering page!');
		}
});
///////////////////////////////////////////////////////////////////////////
// Users
///////////////////////////////////////////////////////////////////////////
router.get('/users', defaultLimiter,
	ensureAuthenticated,
	async (req, res) => {
		try{
			if (req.user.superuser === true) {
				sendPageViewUid(req.path, 'User Admin', req.ip, req.user.username, req.headers['user-agent']);
				let totalCount = await Account.countDocuments({});
				// https://docs.mongodb.com/manual/reference/method/db.collection.find/#explicitly-excluded-fields
				let usersAndDevs = await Account.aggregate([
					{ "$lookup": {
						"from": "devices",
						"let": { "username": "$username" },
						"pipeline": [
						  { "$match": {
							"$expr": { "$eq": [ "$$username", "$username" ] }
						  }},
						  { "$count": "count" }
						],
						"as": "deviceCount"
					  }},
					  { "$addFields": {
						"countDevices": { "$sum": "$deviceCount.count" }
					  }}
				 ]);
				res.render('pages/users',{user:req.user, users: usersAndDevs, usercount: totalCount, brand: process.env.BRAND, title: "User Admin | " + process.env.BRAND});
			}
			else {
				res.redirect(303, '/');
			}
		}
		catch(e){
			logger.log('error', "[Admin Users] Error rendering page, error: " + e.stack);
			res.status(500).send('Error rendering page!');
		}
});
///////////////////////////////////////////////////////////////////////////
// Users Topics
///////////////////////////////////////////////////////////////////////////
router.post('/toggle-topics/:username', defaultLimiter,
	ensureAuthenticated,
	async (req, res) => {
		try{
			// Check req.user is super user
			if (req.user.superuser === true) {
				if (!req.params.username) return res.status(400).send('Username not supplied!');
				// Get user-specific ACL
				let aclUser = await Topics.findOne({topics:	['command/' + req.params.username + '/#','state/' + req.params.username + '/#','response/' + req.params.username + '/#','message/' + req.params.username + '/#']});
				if (!aclUser) {
					// Generate user-specific MQTT topics
					aclUser = new Topics({topics: [
						'command/' + req.params.username +'/#',
						'state/'+ req.params.username + '/#',
						'response/' + req.params.username + '/#',
						'message/' + req.params.username + '/#'
					]});
					// Save new user-specific MQTT topics
					await aclUser.save();
				}
				// // Get User
				let account = await Account.findByUsername(req.params.username, true);
				// Apply topic change
				await Account.updateOne({username: account.username},{$set: {topics: aclUser._id}});
				logger.log('debug' , "[Reset Topics] Reset MQTT topics for user: " + account.username + ", to: " + JSON.stringify(aclUser));

				// if (!account) return res.status(500).send('Account not found!');
				// // Set user.topics to pattern-based MQTT topics
				// if (account.topics == aclPattern._id){
				// 	await Account.updateOne({username: account.username},{$set: {topics: aclUser._id}});
				// 	logger.log('debug' , "[Reset Topics] Reset MQTT topics for user: " + account.username + ", to: " + JSON.stringify(aclUser));
				// }
				// // Set user.topics back to per-user MQTT topics
				// else {
				// 	await Account.updateOne({username: account.username},{$set: {topics: aclPattern._id}});
				// 	logger.log('debug' , "[Reset Topics] Updated MQTT topics for user to pattern: " + account.username + ", to: " + JSON.stringify(aclPattern));
				// }
			}
			// Not superuser, redirect
			else {
				res.redirect(303, '/');
			}
		}
		// Error handler
		catch(e){
			logger.log('error', "[Reset Topics] Failed to reset topics for user, error: " + e.stack);
			return res.status(500).send('Error!');
		}
});
///////////////////////////////////////////////////////////////////////////
// User Disable/ Enable
///////////////////////////////////////////////////////////////////////////
router.post('/user/:id/:state', defaultLimiter,
	ensureAuthenticated,
	async (req, res) => {
		try{
			if (req.user.username === mqtt_user && req.params.id && req.params.state) {
				// Convert string input to boolean
				let state = (req.params.state === "true");
				let result = await toggleUser(req.params.id, state);
				if (result == true) {
					return res.status(200).send('Updated Account State!');
				}
				else {
					return res.status(400).send("Error updating account state!");
				}
			}
			else if (req.user.username !== mqtt_user) {
				return res.redirect(303, '/');
			}
			else if (!req.params.id && !req.params.state) {
				return res.status(400).send("Please supply user _id and account state");
			}
		}
		catch(e){
			logger.log('error', "[Admin Users] Error disabling/ enabling user, error: " + e.stack);
			return res.status(400).send("Error updating account state!");
		}
});

///////////////////////////////////////////////////////////////////////////
// User Devices
///////////////////////////////////////////////////////////////////////////
router.get('/user-devices', defaultLimiter,
	ensureAuthenticated,
	async (req, res) => {
		try {
			if (req.user.superuser === true) {
				sendPageViewUid(req.path, 'User Device Admin', req.ip, req.user.username, req.headers['user-agent']);
				let devices = await Devices.find({});
				let count = await Devices.countDocuments({});
				res.render('pages/user-devices',{user:req.user, devices: devices, devicecount: count, brand: process.env.BRAND, title: "Device Admin | " + process.env.BRAND});
			}
			else {
				res.redirect(303, '/');
			}
		}
		catch(e){
			logger.log('error', "[Admin Devices] Error rendering page, error: " + e.stack);
			res.status(500).send('Error rendering page!');
		}

});
///////////////////////////////////////////////////////////////////////////
// Services (Put)
///////////////////////////////////////////////////////////////////////////
router.put('/services', defaultLimiter,
ensureAuthenticated,
async (req, res) => {
	try{
		if (req.user.username == mqtt_user) {
			let application = oauthModels.Application(req.body);
			await application.save();
			res.status(201).send(application);
		} else {
			//res.status(401).send();
			res.redirect(303, '/');
		}
	}
	catch(e){
		logger.log('error', "[Admin Services] Error saving new service, error: " + e.stack);
		res.status(500).send('Unable to save service!');
	}

});
///////////////////////////////////////////////////////////////////////////
// Service (Post)
///////////////////////////////////////////////////////////////////////////
router.post('/service/:id', defaultLimiter,
ensureAuthenticated,
async (req, res) => {
	try{
		let service = req.body;
		if (req.user.username == mqtt_user) {
			await oauthModels.Application.findOne({_id: req.params.id});
			data.title = service.title;
			data.oauth_secret = service.oauth_secret;
			data.domains = service.domains;
			data.save();
			res.status(201).send(data);
		} else {
			res.redirect(303, '/');
		}
	}
	catch(e) {
		logger.log('error', "[Admin Services] Error editing service, error: " + e.stack);
		res.status(500).send('Unable to modify service!');
	}

});
///////////////////////////////////////////////////////////////////////////
// Service (Delete)
///////////////////////////////////////////////////////////////////////////
router.delete('/service/:id', defaultLimiter,
ensureAuthenticated,
async (req, res) => {
	try{
		if (req.user.username == mqtt_user) {
			await oauthModels.Application.remove({_id:req.params.id});
			res.status(200).send();
		} else {
			res.redirect(303, '/');
		}
	}
	catch(e){
		logger.log('error', "[Admin Services] Error deleting service, error: " + e.stack);
		res.status(500).send('Unable to delete service!');
	}
});
///////////////////////////////////////////////////////////////////////////
// Functions
///////////////////////////////////////////////////////////////////////////
function ensureAuthenticated(req,res,next) {
	//console.log("ensureAuthenticated - %j", req.isAuthenticated());
	//console.log("ensureAuthenticated - %j", req.user);
	//console.log("ensureAuthenticated - %j", req.session);
	if (req.isAuthenticated()) {
    	return next();
	} else {
		//console.log("failed auth?");
		res.redirect('/login');
	}
}

const toggleUser = async(id, enabled) => {
	try {
		// Find User
		let user = await Account.findOne({_id: id});
		// Set Account Status
		if (enabled == true && user.username != mqtt_user) {
			user.active = true
			logger.log('verbose', "[Admin] Enabling User Account: " + user.username);
		}
		else if (enabled == false && user.username != mqtt_user) {
			user.active = false
			logger.log('verbose', "[Admin] Disabling User Account: " + user.username);
		}
		else {
			logger.log('error', "[Admin] toggleUser invalid state requested: " + enabled);
			return false;
		}
		// Save Account
		await user.save();
		logger.log('verbose', "[Admin] Account saved following 'active' element change: " + user.username);
		return true;
	}
	catch(e) {
		logger.log('error', "[Admin] Unable to change user 'active' element, error: " + e);
		return false;
	}
}

module.exports = router;