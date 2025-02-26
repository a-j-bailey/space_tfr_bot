class TfrDetailsParser {
	constructor() {
		this.details = {
			mission_id: '',
			mission_provider: '',
			mission_name: '',
			issue_date: '',
			effective_date: '',
			effective_tz: '',
			expiry_date: '',
			expiry_tz: '',
			city: '',
			state: '',
			facility: '',
			facility_code: '',
			alt_min: 0,
			alt_max: 0,
			coordinates: [],
		};
	}

	async parse(xmlText) {
		function getProvider(mission) {
			const providers = {
				'SpaceX': ['SpaceX', 'SpX', 'SpaveX'],
				'Blue Origin': ['Blue Origin'],
				'ULA': ['ULA'],
			}

			let provider = '';

			Object.keys(providers).forEach((key) => {
				if (providers[key].some(option => mission.includes(option))) {
					provider = key
				}
			})

			return provider;
		}

		const getValue = (tag) => {
			const match = xmlText.match(new RegExp(`<${tag}>([^<]+)</${tag}>`));
			return match ? match[1].trim() : '';
		};

		const localName = getValue('txtLocalName')
		this.details.mission_id = localName;
		const parsed = localName.match(/^\d+([^()]+)\(/)
		if (parsed) {
			const provider = getProvider(parsed[1].trim())
			const name = parsed[1].trim().split(provider)
			const mission_name = provider ? name[name.length - 1].trim() : parsed[1].trim()

			this.details.mission_provider = provider;
			this.details.mission_name = mission_name;
		}

		this.details.issue_date = getValue('dateIssued');

		// DATE / TIME
		this.details.effective_date = getValue('dateEffective');
		this.details.expiry_date = getValue('dateExpire');
		this.details.effective_tz = getValue('codeTimeZone');
		this.details.expiry_tz = getValue('codeExpirationTimeZone');

		// LOCATION
		this.details.city = getValue('txtNameCity');
		this.details.state = getValue('txtNameUSState');

		this.details.facility = getValue('txtNameCoordFacility');
		this.details.facility_code = getValue('codeCoordFacility');

		this.details.alt_min = parseInt(getValue('valDistVerLower'));
		this.details.alt_max = parseInt(getValue('valDistVerUpper')) * 100;

		// Extract coordinates from Avx tags
		const coords = [];
		const avxMatches = xmlText.match(/<Avx>[\s\S]*?<\/Avx>/g) || [];

		avxMatches.forEach(avx => {
			const lat = avx.match(/<geoLat>([^<]+)<\/geoLat>/)?.[1];
			const long = avx.match(/<geoLong>([^<]+)<\/geoLong>/)?.[1];
			if (lat && long) {
				// Convert decimal coordinates to degrees format
				coords.push({ lat, long });
			}
		});

		this.details.coordinates = coords;

		return this.details;
	}
}

async function generateOAuthSignature(method, url, params, consumerSecret, tokenSecret) {
	const baseString = [
		method.toUpperCase(),
		encodeURIComponent(url),
		encodeURIComponent(Object.keys(params)
			.sort()
			.map(key => `${key}=${params[key]}`)
			.join('&'))
	].join('&');

	const signingKey = `${encodeURIComponent(consumerSecret)}&${encodeURIComponent(tokenSecret)}`;

	// Convert strings to Uint8Arrays
	const encoder = new TextEncoder();
	const baseStringBytes = encoder.encode(baseString);
	const signingKeyBytes = encoder.encode(signingKey);

	// Create HMAC key
	const key = await crypto.subtle.importKey(
		'raw',
		signingKeyBytes,
		{ name: 'HMAC', hash: 'SHA-1' },
		false,
		['sign']
	);

	// Sign the base string
	const signature = await crypto.subtle.sign(
		'HMAC',
		key,
		baseStringBytes
	);

	// Convert to base64
	return btoa(String.fromCharCode(...new Uint8Array(signature)));
}

async function postTweet(tfr, env) {
	const tweetText = formatTfrTweet(tfr);

	if (env.ENVIRONMENT !== 'production') {
		// Don't tweet in non-production environments.
		return true;
	}

	console.log('Attempting to post tweet:', tfr.notam_id);

	try {
		const url = 'https://api.twitter.com/2/tweets';
		const timestamp = Math.floor(Date.now() / 1000).toString();
		const nonce = Math.random().toString(36).substring(2);

		const oauthParams = {
			oauth_consumer_key: env.TWITTER_API_KEY,
			oauth_nonce: nonce,
			oauth_signature_method: 'HMAC-SHA1',
			oauth_timestamp: timestamp,
			oauth_token: env.TWITTER_ACCESS_TOKEN,
			oauth_version: '1.0'
		};

		const signature = await generateOAuthSignature(
			'POST',
			url,
			oauthParams,
			env.TWITTER_API_SECRET,
			env.TWITTER_ACCESS_TOKEN_SECRET
		);

		const authHeader = 'OAuth ' + Object.entries({
			...oauthParams,
			oauth_signature: signature
		})
			.map(([key, value]) => `${key}="${encodeURIComponent(value)}"`)
			.join(', ');

		const response = await fetch(url, {
			method: 'POST',
			headers: {
				'Authorization': authHeader,
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({
				text: tweetText
			})
		});

		const responseText = await response.text();

		if (!response.ok) {
			throw new Error(`Twitter API error: ${responseText}`);
		}

		console.log('Tweet posted successfully for TFR:', tfr.notam_id);
		return true;
	} catch (error) {
		console.error('Error posting tweet:', error);
		console.error('Error details:', error.message);
		return false;
	}
}

function formatTfrTweet(tfr) {
	const formatOptions = {
		timeZone: tfr.effective_tz,
		year: 'numeric',
		month: 'short',
		day: '2-digit',
		hour: 'numeric',
		minute: 'numeric',
		timeZoneName: 'short',
		hour12: false
	}
	const startTime = new Date(tfr.effective_date + '.000Z').toLocaleString('en-US', formatOptions)
	const endTime = new Date(tfr.expiry_date + '.000Z').toLocaleString('en-US', formatOptions)

	let content = `📍 ${tfr.city}, ${tfr.state}
🗓️ ${startTime} to ${endTime}\n`

	if (tfr.mission_name) {
		content += `\n🚀 ${tfr.mission_name}`
	}

	if (tfr.mission_provider) {
		content += `\n🏢 ${tfr.mission_provider}`
	}

	return content + `\n\n${getUrl(tfr.notam_id, 'public')}`;
}

async function updateStoredTfrs(newTfrs, env) {
	let existingTfrs = await getStoredTfrs(env);

	const mergedTfrs = [...existingTfrs];
	newTfrs.forEach(newTfr => {
		if (!mergedTfrs.some(tfr => tfr.notam_id === newTfr.notam_id)) {
			mergedTfrs.push(newTfr);
		}
	})

	try {
		await env.TFR_STORAGE.put('tfrs', JSON.stringify(mergedTfrs));
		console.log('Stored in KV:', mergedTfrs.length, 'TFRs');
	} catch (error) {
		console.error('Error writing to KV:', error);
	}

	return newTfrs;
}

async function getStoredTfrs(env) {
	let existingTfrs = [];
	try {
		const stored = await env.TFR_STORAGE.get('tfrs', { type: 'json' });
		console.log('Retrieved from KV:', stored ? stored.length : 0, 'TFRs');
		existingTfrs = stored || [];
	} catch (error) {
		console.error('Error reading from KV:', error);
		existingTfrs = [];
	}

	return existingTfrs;
}

async function filterNewTfrs(allTFRs, env) {
	let existingTfrs = await getStoredTfrs(env);
	let newTfrs = []

	newTfrs = allTFRs.filter(newTfr => !existingTfrs.some(existingTfr => existingTfr.notam_id === newTfr.notam_id));

	return newTfrs;
}

function getUrl(notam_id, type) {
	const notam = notam_id.split('/');
	const detail = `detail_${notam[0]}_${notam[1]}`;

	switch (type) {
		case 'xml':
			return `https://tfr.faa.gov/download/${detail}.xml`
		case 'public':
			return `https://tfr.faa.gov/tfr3/?page=${detail}`
	}
}

export default {
	/**
	 * @param {Request} request
	 * @param {Env} env
	 * @param {ExecutionContext} ctx
	 * @returns {Promise<Response>}
	 */
	async fetch(request, env, ctx) {
		// Add CORS headers to all responses
		const corsHeaders = {
			'Access-Control-Allow-Origin': '*',
			'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
			'Access-Control-Allow-Headers': 'Content-Type',
		};

		// Handle OPTIONS request for CORS
		if (request.method === 'OPTIONS') {
			return new Response(null, {
				headers: corsHeaders
			});
		}

		try {
			// Check if we want stored TFRs only
			if (request.url.endsWith('/stored')) {
				const stored = await env.TFR_STORAGE.get('tfrs', { type: 'json' });
				return Response.json({
					success: true,
					data: stored || []
				}, {
					headers: corsHeaders
				});
			}

			const result = await this.processTfrs(env);
			return Response.json({
				success: true,
				data: result
			}, {
				headers: corsHeaders
			});
		} catch (error) {
			console.error('Error in fetch handler:', error);
			return Response.json({
				success: false,
				error: error.message || 'Internal Server Error',
				stack: error.stack
			}, {
				status: 500,
				headers: corsHeaders
			});
		}
	},

	/**
	 * @param {ScheduledController} controller
	 * @param {Env} env
	 * @param {ExecutionContext} ctx
	 */
	async scheduled(controller, env, ctx) {
		// This runs on the cron schedule
		try {
			const result = await this.processTfrs(env);
			console.log('Cron job completed:', result);
		} catch (error) {
			console.error('Error in scheduled job:', error);
		}
	},

	/**
	 * @param {Env} env
	 * @returns {Promise<Object>}
	 */
	async processTfrs(env) {
		try {
			// Fetch and parse new TFRs
			const rawTFRs = await fetch("https://tfr.faa.gov/tfrapi/getTfrList")
				.then(response => response.json());

			const spaceOperationsTFRs = rawTFRs.filter(tfr => tfr.type === 'SPACE OPERATIONS');

			const newTfrs = await filterNewTfrs(spaceOperationsTFRs, env)

			// If no new TFRs, return early
			if (newTfrs.length === 0) {
				return {
					message: "No new TFRs found",
					tweetsPosted: 0
				};
			}

			const tfrMap = new Map();

			newTfrs.forEach(tfr => {
				if (tfr && !tfrMap.has(tfr.notam_id)) {
					tfrMap.set(tfr.notam_id, tfr);
				}
			});

			const promises = newTfrs.map(async tfr => {
				const response = await fetch(getUrl(tfr.notam_id, 'xml'));
				const xmlText = await response.text();

				const detailsParser = new TfrDetailsParser();
				const details = await detailsParser.parse(xmlText);

				tfrMap.set(tfr.notam_id, { ...tfr, ...details });
			})

			await Promise.all(promises);

			// Post tweets for each new TFR
			const tweetResults = [];

			tfrMap.forEach(async (tfr) => {
				const success = await postTweet(tfr, env);
				if (success) {
					tweetResults.push({
						notam: tfr.notam_id,
						tweetText: formatTfrTweet(tfr),
						success: true
					});
				}
				return;
			});

			await updateStoredTfrs(Array.from(tfrMap.values()), env)

			return {
				message: `Posted ${tweetResults.length} tweets`,
				tweets: tweetResults,
				newTfrs: newTfrs.length
			};
		} catch (error) {
			console.error('Error processing TFRs:', error);
			throw error;
		}
	},
};
