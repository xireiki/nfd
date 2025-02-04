const TOKEN = ENV_BOT_TOKEN
const WEBHOOK = '/endpoint'
const SECRET = ENV_BOT_SECRET
const ADMIN_UID = ENV_ADMIN_UID
const START_MSG = ENV_START_MSG
const ADMIN_START_MSG = ENV_ADMIN_START_MSG
const NOTIFY_INTERVAL = 3600 * 1000;
const fraudDb = 'https://raw.githubusercontent.com/LloydAsp/nfd/main/data/fraud.db';
const startMsgUrl = 'https://raw.githubusercontent.com/LloydAsp/nfd/main/data/startMessage.md';

function apiUrl (methodName, params = null) {
	let query = ''
	if (params) {
		query = '?' + new URLSearchParams(params).toString()
	}
	return `https://api.telegram.org/bot${TOKEN}/${methodName}${query}`
}

function requestTelegram(methodName, body, params = null){
	return fetch(apiUrl(methodName, params), body)
		.then(r => r.json())
}

function makeReqBody(body){
	return {
		method: 'POST',
		headers: {
			'content-type': 'application/json'
		},
		body: JSON.stringify(body)
	}
}

function sendMessage(msg = {}, params = null){
	return requestTelegram('sendMessage', makeReqBody(msg), params)
}

function copyMessage(msg = {}){
	return requestTelegram('copyMessage', makeReqBody(msg))
}

function forwardMessage(msg){
	return requestTelegram('forwardMessage', makeReqBody(msg))
}

function getChat(id){
	return requestTelegram('getChat', null, {chat_id: id})
}

/**
 * Wait for requests to the worker
 */
addEventListener('fetch', event => {
	const url = new URL(event.request.url)
	if (url.pathname === WEBHOOK) {
		event.respondWith(handleWebhook(event))
	} else if (url.pathname === '/registerWebhook') {
		event.respondWith(registerWebhook(event, url, WEBHOOK, SECRET))
	} else if (url.pathname === '/unRegisterWebhook') {
		event.respondWith(unRegisterWebhook(event))
	} else {
		event.respondWith(new Response('No handler for this request'))
	}
})

/**
 * Handle requests to WEBHOOK
 * https://core.telegram.org/bots/api#update
 */
async function handleWebhook (event) {
	// Check secret
	if (event.request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== SECRET) {
		return new Response('Unauthorized', { status: 403 })
	}

	// Read request body synchronously
	const update = await event.request.json()
	// Deal with response asynchronously
	event.waitUntil(onUpdate(update))

	return new Response('Ok')
}

/**
 * Handle incoming Update
 * https://core.telegram.org/bots/api#update
 */
async function onUpdate (update) {
	if ('message' in update) {
		await onMessage(update.message)
	}
}

/**
 * Handle incoming Message
 * https://core.telegram.org/bots/api#message
 */
async function onMessage (message) {
	if(message.text === '/start'){
		let startMsg = await isAdmin(message.chat.id) ? ADMIN_START_MSG : START_MSG
		return sendMessage({
			chat_id: message.chat.id,
			text: startMsg,
		}, { parse_mode: "MarkdownV2" })
	}
	if(await isAdmin(message.chat.id)){
		if(/^\/addadmin/.exec(message.text)){
			return handleAddAdmin(message)
		}
		if(/^\/deladmin/.exec(message.text)){
			return handleDeleteAdmin(message)
		}
		if(/^\/listadmin$/.exec(message.text)){
			return handleListAdmin(message)
		}
		if(!message?.reply_to_message?.chat){
			return sendMessage({
				chat_id: message.chat.id,
				text: '使用方法，回复转发的消息，并发送回复消息，或者 `/block`、`/unblock`、`/checkblock` 等指令'
			}, { parse_mode: "MarkdownV2" })
		}
		if(/^\/block/.exec(message.text)){
			return handleBlock(message)
		}
		if(/^\/unblock$/.exec(message.text)){
			return handleUnBlock(message)
		}
		if(/^\/checkblock$/.exec(message.text)){
			return checkBlock(message)
		}
		let guestChantId = await nfd.get('msg-map-' + message?.reply_to_message.message_id, { type: "json" })
		return copyMessage({
			chat_id: guestChantId,
			from_chat_id: message.chat.id,
			message_id: message.message_id,
		})
	}
	return handleGuestMessage(message)
}

async function handleGuestMessage(message){
	let chatId = message.chat.id;
	let userStatus = await nfd.get('user-status-' + chatId, { type: "json" })
	const isblocked = userStatus?.blocked && userStatus?.block?.expire != null && userStatus?.block?.expire != undefined && (userStatus?.block?.expire > Date.now() || userStatus?.block?.expire == 0)
	
	if(isblocked){
		return sendMessage({
			chat_id: chatId,
			text: 'Your are blocked'
		})
	}

	for(const admin of await admins()){
		const forwardReq = await forwardMessage({
			chat_id: admin,
			from_chat_id: message.chat.id,
			message_id: message.message_id
		})
		if(forwardReq.ok){
			await nfd.put(`msg-map-${admin}-` + forwardReq.result.message_id, chatId)
		}
	}
	return handleNotify(message)
}

async function handleNotify(message){
	let chatId = message.chat.id;
	if(await isFraud(chatId)){
		for (const admin of await admins()){
			await sendMessage({
				chat_id: admin,
				text:`检测到骗子，UID: ${chatId}`
			})
		}
	}
}

async function handleBlock(message){
	let guestChantId = await nfd.get(`msg-map-${message.chat.id}-` + message.reply_to_message.message_id, { type: "json" })
	if(await isAdmin(guestChantId)){
		return sendMessage({
			chat_id: message.chat.id,
			text: '不能屏蔽管理员'
		})
	}
	const {reason, time} = parseBlockParam(message.text)
	await nfd.put('user-status-' + guestChantId, JSON.stringify({
		blocked: true,
		block: {
			reason: reason,
			expire: time > 0 ? Date.now() + (time * 1000) : 0
		}
	}))

	return sendMessage({
		chat_id: message.chat.id,
		text: `UID: ${guestChantId} 屏蔽成功`,
	})
}

async function handleUnBlock(message){
	let guestChantId = await nfd.get(`msg-map-${message.chat.id}-` + message.reply_to_message.message_id, { type: "json" })

	await nfd.put('user-status-' + guestChantId, JSON.stringify({blocked: false}))

	return sendMessage({
		chat_id: message.chat.id,
		text:`UID: ${guestChantId} 解除屏蔽成功`,
	})
}

async function checkBlock(message){
	let guestChantId = await nfd.get(`msg-map-${message.chat.id}-` + message.reply_to_message.message_id, { type: "json" })
	let userStatus = await nfd.get('user-status-' + guestChantId, { type: "json" })

	let block = `UID: ${guestChantId} `
	if (userStatus?.blocked && userStatus?.block?.expire != null && userStatus?.block?.expire != undefined && (userStatus?.block?.expire > Date.now() || userStatus?.block?.expire == 0)) {
		block += "被屏蔽了" + getRE(userStatus)
	} else {
		block += "没有被屏蔽"
	}

	return sendMessage({
		chat_id: message.chat.id,
		text: block
	})
}

async function handleAddAdmin(message){
	if(ADMIN_UID !== message.chat.id.toString()){
		return sendMessage({
			chat_id: message.chat.id,
			text: "仅限 *bot 所有者* 使用！"
		}, { parse_mode: "MarkdownV2" })
	}
	const param = message.text.split(" ")
	if(param < 2){
		return sendMessage({
			chat_id: message.chat.id,
			text: "使用 `/addadmin ID` 添加管理员"
		}, { parse_mode: "MarkdownV2" })
	}
	if(/^\d+$/.test(param[1])){
		const ExtraAdmin = await nfd.get("admin-list", { type: "json" }) || []
		ExtraAdmin.push(param[1])
		await nfd.put("admin-list", JSON.stringify(ExtraAdmin))
		const adminInfo = await getChat(param[1])
		const fullname = ("ok" in adminInfo && adminInfo.ok) ? (adminInfo.result?.first_name + (adminInfo.result?.last_name ? " " + adminInfo.result?.last_name : "") + `\\(${param[1]}\\)`) : param[1]
		return sendMessage({
			chat_id: message.chat.id,
			text: `已添加管理员: ${fullname}`
		}, { parse_mode: "MarkdownV2" })
	} else {
		return sendMessage({
			chat_id: message.chat.id,
			text: "错误的 ID，使用 `/addadmin ID` 添加管理员"
		}, { parse_mode: "MarkdownV2" })
	}
}

async function handleDeleteAdmin(message){
	if(ADMIN_UID !== message.chat.id.toString()){
		return sendMessage({
			chat_id: message.chat.id,
			text: "仅限 *bot 所有者* 使用！"
		}, { parse_mode: "MarkdownV2" })
	}
	const param = message.text.split(" ")
	if(param < 2){
		return sendMessage({
			chat_id: message.chat.id,
			text: "使用 `/deladmin ID` 删除管理员"
		})
	}
	if(/^\d+$/.test(param[1])){
		const ExtraAdmin = await nfd.get("admin-list", { type: "json" }) || []
		const newExtraAdmin = ExtraAdmin.filter(item => item !== param[1])
		await nfd.put("admin-list", JSON.stringify(newExtraAdmin))
		const adminInfo = await getChat(param[1])
		const fullname = ("ok" in adminInfo && adminInfo.ok) ? (adminInfo.result?.first_name + (adminInfo.result?.last_name ? " " + adminInfo.result?.last_name : "") + `\\(${param[1]}\\)`) : param[1]
		return sendMessage({
			chat_id: message.chat.id,
			text: `已删除管理员: ${fullname}`
		}, { parse_mode: "MarkdownV2" })
	} else {
		return sendMessage({
			chat_id: message.chat.id,
			text: "错误的 ID，使用 `/deladmin ID` 删除管理员"
		}, { parse_mode: "MarkdownV2" })
	}
}

async function handleListAdmin(message){
	if(ADMIN_UID !== message.chat.id.toString()){
		return sendMessage({
			chat_id: message.chat.id,
			text: "仅限 *bot 所有者* 使用！"
		}, { parse_mode: "MarkdownV2" })
	}
	const ExtraAdmin = await nfd.get("admin-list", { type: "json" }) || []
	const adminList = [ADMIN_UID, ...ExtraAdmin]
	if(adminList.length >= 1){
		let result = "管理员列表："
		for(const admin of adminList){
			const adminInfo = await getChat(admin)
			if("ok" in adminInfo && adminInfo.ok){
				const fullname = adminInfo.result?.first_name + (adminInfo.result?.last_name ? " " + adminInfo.result?.last_name : "")
				result += `\n \\- ${fullname}\\(\`${admin}\`\\)`
			} else {
				result += `\n \\- ${admin}`
			}
		}
		return sendMessage({
			chat_id: message.chat.id,
			text: result
		}, { parse_mode: "MarkdownV2" })
	} else {
		return sendMessage({
			chat_id: message.chat.id,
			text: "没有其他管理员"
		})
	}
}

/**
 * Send plain text message
 * https://core.telegram.org/bots/api#sendmessage
 */
async function sendPlainText (chatId, text) {
	return sendMessage({
		chat_id: chatId,
		text: text
	})
}

/**
 * Set webhook to this worker's url
 * https://core.telegram.org/bots/api#setwebhook
 */
async function registerWebhook (event, requestUrl, suffix, secret) {
	// https://core.telegram.org/bots/api#setwebhook
	const webhookUrl = `${requestUrl.protocol}//${requestUrl.hostname}${suffix}`
	const r = await (await fetch(apiUrl('setWebhook', { url: webhookUrl, secret_token: secret }))).json()
	return new Response('ok' in r && r.ok ? 'Ok' : JSON.stringify(r, null, 2))
}

/**
 * Remove webhook
 * https://core.telegram.org/bots/api#setwebhook
 */
async function unRegisterWebhook (event) {
	const r = await (await fetch(apiUrl('setWebhook', { url: '' }))).json()
	return new Response('ok' in r && r.ok ? 'Ok' : JSON.stringify(r, null, 2))
}

async function isFraud(id){
	id = id.toString()
	let db = await fetch(fraudDb).then(r => r.text())
	let arr = db.split('\n').filter(v => v)
	console.log(JSON.stringify(arr))
	let flag = arr.filter(v => v === id).length !== 0
	console.log(flag)
	return flag
}

async function isAdmin(id) {
	const ExtraAdmin = await nfd.get("admin-list", { type: "json" }) || []
	return [ADMIN_UID, ...ExtraAdmin].includes(id.toString())
}

async function isAdminWithID(id) {
	if (id.toString() === ADMIN_UID) {
		return [true, ADMIN_UID]
	}
	const ExtraAdmin = await nfd.get("admin-list", { type: "json" }) || []
	const index = ExtraAdmin.indexOf(id.toString())
	if (index >= 0) {
		return [true, ExtraAdmin[index]]
	}
	return [false, null]
}

async function admins(){
	const ExtraAdmin = await nfd.get("admin-list", { type: "json" }) || []
	return [ADMIN_UID, ...ExtraAdmin]
}

function parseBlockParam(str){
	let result = {
		time: 0,
		reason: "",
	}
	const matches = str.match(/^\/?[a-z]+( +(\d+[Mdhms]))?( +(.*))?/);
	if(matches) {
		const timeStr = matches[2] || "0";
		result.time = parseTime(timeStr);
		result.reason = matches[4] || "";
	}
	return result
}

function parseTime(timeStr) {
	const timeRegex = /(\d+)([Mdhms])/;
	const matches = timeStr.match(timeRegex);
	if (matches) {
		const num = parseInt(matches[1], 10);
		const unit = matches[2];
		switch (unit) {
			case 'M':
				return num * 30 * 24 * 60 * 60;
			case 'd':
				return num * 24 * 60 * 60;
			case 'h':
				return num * 60 * 60;
			case 'm':
				return num * 60;
			case 's':
				return num;
			default:
				return num;
		}
	}
	return 0;
}

function getRE(userStatus) {
	let result = ""
	if(userStatus.block?.reason) result += "\n - 原因: " + userStatus.block?.reason
	if(userStatus.block?.expire != undefined && userStatus.block?.expire != null && userStatus.block?.expire >= 0) {
		if(userStatus.block?.expire == 0) {
			result += "\n - 到期: 永久"
		} else {
			const date = new Date(userStatus.block?.expire + 8 * 60 * 60 * 1000)
			result += "\n - 到期: " + date.toISOString().replace(/T/, " ").replace(/\..+/, "").substring(0, 19);
		}
	}
	return result
}
