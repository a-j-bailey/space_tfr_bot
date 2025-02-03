/**
 * @typedef {Object} Env
 */

class TableParser {
	constructor() {
		this.tfrs = [];
		this.currentRow = {};
		this.columnIndex = 0;
		this.columns = ['date', 'notam', 'facility', 'state', 'type', 'description'];
		this.inDataRow = false;
		this.currentText = '';
		this.isSpaceOperation = false;
		this.currentUrl = '';
	}

	element(element) {
		if (element.tagName === 'tr') {
			const bgColor = element.getAttribute('bgcolor');
			if (bgColor === 'ffffff' || bgColor === 'e7ffff') {
				this.inDataRow = true;
				this.currentRow = {};
				this.columnIndex = 0;
				this.isSpaceOperation = false;
				this.currentUrl = '';
			} else {
				this.inDataRow = false;
			}
		}

		if (element.tagName === 'a' && this.inDataRow && this.columnIndex < 6) {
			if (this.columnIndex === 1) {
				this.currentUrl = new URL(element.getAttribute('href'), 'https://tfr.faa.gov').href;
			}
			
			this.currentText = '';
			
			element.onEndTag(() => {
				const content = this.currentText.trim();
				
				if (content) {
					let cleanContent;
					
					if (this.columnIndex === 0) {
						const dateMatch = content.match(/\d{2}\/\d{2}\/\d{4}/) || 
										 content.match(/\d{2}\/\d{2}\/\d{2}/) ||
										 content.match(/\d{1,2}\/\d{1,2}\/\d{4}/);
						cleanContent = dateMatch ? dateMatch[0] : content.trim();
					} else if (this.columnIndex === 5) {
						const lines = content.split(/[\r\n]+/)
							.map(line => line.trim())
							.filter(line => line.length > 2);
						cleanContent = lines.reduce((a, b) => a.length > b.length ? a : b, '');
					} else {
						const parts = content.match(/(.+?)(?:\1+|$)/);
						cleanContent = parts ? parts[1].trim() : content.trim();
						if (cleanContent.length < 2) {
							cleanContent = content.trim();
						}
						
						if (this.columnIndex === 4 && cleanContent === 'SPACE OPERATIONS') {
							this.isSpaceOperation = true;
						}
					}
					
					this.currentRow[this.columns[this.columnIndex]] = cleanContent;
					this.columnIndex++;
					
					if (this.columnIndex === 6 && this.isSpaceOperation) {
						this.currentRow.url = this.currentUrl;
						this.tfrs.push({...this.currentRow});
					}
				}
			});
		}
	}

	text(text) {
		if (this.inDataRow && this.columnIndex < 6) {
			this.currentText += text.text;
		}
	}
}

// New class to parse coordinates from TFR detail pages
class CoordinatesParser {
	constructor() {
		this.coordinates = [];
		this.currentRow = [];
		this.inArialFont = false;
		this.currentText = '';
	}

	element(element) {
		if (element.tagName === 'font' && element.getAttribute('face') === 'Arial') {
			this.inArialFont = true;
			this.currentText = '';
			
			element.onEndTag(() => {
				this.inArialFont = false;
				const content = this.currentText.trim()
					.replace(/&#xBA;/g, '°')
					.replace(/&#x2019;/g, "'");
				
				if (content.includes('°')) {
					this.currentRow.push(content);
					
					if (this.currentRow.length === 2) {
						this.coordinates.push({
							lat: this.currentRow[0],
							long: this.currentRow[1]
						});
						this.currentRow = [];
					}
				}
			});
		}
	}

	text(text) {
		if (this.inArialFont) {
			this.currentText += text.text;
		}
	}
}

class TfrDetailsParser {
	constructor() {
		this.details = {
			issueDate: '',
			location: '',
			beginningDateTime: '',
			endingDateTime: '',
			reason: '',
			coordinates: [],
			altitude: '',
			authority: '',
			artcc: '',
			effectiveTimes: '',
			notamNumber: ''
		};
	}

	async parse(xmlText) {
		const getValue = (tag) => {
			const match = xmlText.match(new RegExp(`<${tag}>([^<]+)</${tag}>`));
			return match ? match[1].trim() : '';
		};

		// Basic NOTAM details
		this.details.notamNumber = `FDC ${getValue('txtLocalName')}`;
		this.details.issueDate = getValue('dateIssued');
		
		// Location details
		const city = getValue('txtNameCity');
		const state = getValue('txtNameUSState');
		this.details.location = `${city}, ${state}`;
		
		// Times
		this.details.beginningDateTime = getValue('dateEffective');
		this.details.endingDateTime = getValue('dateExpire');
		
		// Altitude
		const upperAlt = getValue('valDistVerUpper');
		const lowerAlt = getValue('valDistVerLower');
		this.details.altitude = `${lowerAlt}ft to FL${upperAlt}`;

		// Authority and facility
		this.details.authority = getValue('codeType'); // Usually "91.143" for space ops
		this.details.artcc = getValue('codeFacility');
		
		// Daily operation times
		const scheduleMatch = xmlText.match(/<ScheduleGroup>[\s\S]*?<\/ScheduleGroup>/);
		if (scheduleMatch) {
			const startTime = scheduleMatch[0].match(/<startTime>([^<]+)<\/startTime>/)?.[1];
			const endTime = scheduleMatch[0].match(/<endTime>([^<]+)<\/endTime>/)?.[1];
			this.details.effectiveTimes = `${startTime} to ${endTime} UTC daily`;
		}

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

async function getTwitterAccessToken(env) {
	try {
		const credentials = `${env.TWITTER_CLIENT_ID}:${env.TWITTER_CLIENT_SECRET}`;
		const basicAuth = btoa(credentials);
		
		const response = await fetch('https://api.twitter.com/2/oauth2/token', {
			method: 'POST',
			headers: {
				'Authorization': `Basic ${basicAuth}`,
				'Content-Type': 'application/x-www-form-urlencoded'
			},
			body: 'grant_type=client_credentials'
		});

		if (!response.ok) {
			throw new Error(`OAuth error: ${await response.text()}`);
		}

		const data = await response.json();
		return data.access_token;
	} catch (error) {
		console.error('Error getting Twitter access token:', error);
		throw error;
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
	console.log('Attempting to post tweet:', tweetText);
	
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
		console.log('Twitter API response status:', response.status);
		console.log('Twitter API response:', responseText);

		if (!response.ok) {
			throw new Error(`Twitter API error: ${responseText}`);
		}

		console.log('Tweet posted successfully for TFR:', tfr.notam);
		return true;
	} catch (error) {
		console.error('Error posting tweet:', error);
		console.error('Error details:', error.message);
		return false;
	}
}

function formatTfrTweet(tfr) {
	return `New Space Operations TFR:
📍 ${tfr.location}
🗓️ ${tfr.beginningDateTime} to ${tfr.endingDateTime}
--
${tfr.description}
--
${tfr.url}`;
}

async function updateTfrJson(newTfrs, env) {
	let existingTfrs = [];
	let addedTfrs = [];
	try {
		const stored = await env.TFR_STORAGE.get('tfrs', { type: 'json' });
		console.log('Retrieved from KV:', stored ? stored.length : 0, 'TFRs');
		existingTfrs = stored || [];
	} catch (error) {
		console.error('Error reading from KV:', error);
		existingTfrs = [];
	}

	const mergedTfrs = [...existingTfrs];
	for (const newTfr of newTfrs) {
		const existingIndex = mergedTfrs.findIndex(tfr => tfr.notam === newTfr.notam);
		if (existingIndex === -1) {
			// This is a new TFR
			mergedTfrs.push(newTfr);
			addedTfrs.push(newTfr);
		} else {
			// Update existing TFR but don't count as new
			mergedTfrs[existingIndex] = newTfr;
		}
	}

	try {
		await env.TFR_STORAGE.put('tfrs', JSON.stringify(mergedTfrs));
		console.log('Stored in KV:', mergedTfrs.length, 'TFRs');
		console.log('New TFRs found:', addedTfrs.length);
	} catch (error) {
		console.error('Error writing to KV:', error);
	}

	return addedTfrs;  // Only return the new TFRs
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

			// Fetch and parse new TFRs
			const response = await fetch("https://tfr.faa.gov/tfr2/list.html");
			const html = await response.text();

			const tableParser = new TableParser();
			const rewriter = new HTMLRewriter()
				.on('tr', tableParser)
				.on('td', tableParser)
				.on('a', tableParser);

			await rewriter.transform(new Response(html)).text();

			const urlMap = new Map();
			
			tableParser.tfrs.forEach(tfr => {
				if (tfr.url && !urlMap.has(tfr.url)) {
					urlMap.set(tfr.url, null);
				}
			});

			const fetchPromises = Array.from(urlMap.keys()).map(async url => {
				const xmlUrl = url.replace('.html', '.xml');
				const response = await fetch(xmlUrl);
				const xmlText = await response.text();

				const detailsParser = new TfrDetailsParser();
				const details = await detailsParser.parse(xmlText);
				
				urlMap.set(url, details);
			});

			await Promise.all(fetchPromises);

			tableParser.tfrs.forEach(tfr => {
				if (tfr.url) {
					const details = urlMap.get(tfr.url);
					tfr.coordinates = details.coordinates || [];
					tfr.issueDate = details.issueDate;
					tfr.location = details.location;
					tfr.beginningDateTime = details.beginningDateTime;
					tfr.endingDateTime = details.endingDateTime;
					tfr.reason = details.reason;
					console.log('Parsed details:', details);
					console.log('Updated TFR:', tfr);
				}
			});

			const updatedTfrs = await updateTfrJson(tableParser.tfrs, env);
			
			// If no new TFRs, return early
			if (updatedTfrs.length === 0) {
				return Response.json({
					success: true,
					data: {
						message: "No new TFRs found",
						tweetsPosted: 0
					}
				}, {
					headers: corsHeaders
				});
			}

			// Post tweets for each new TFR
			const tweetResults = [];
			// for (const tfr of updatedTfrs) {
			// 	const tweetText = formatTfrTweet(tfr);
			// 	const success = await postTweet(tfr, env);
			// 	if (success) {
			// 		tweetResults.push({
			// 			notam: tfr.notam,
			// 			tweetText: tweetText,
			// 			success: true
			// 		});
			// 	}
			// }

			return Response.json({
				success: true,
				data: {
					message: `Posted ${tweetResults.length} tweets`,
					tweets: tweetResults
				}
			}, {
				headers: corsHeaders
			});

		} catch (error) {
			console.error('Error in fetch handler:', error);
			
			return Response.json({
				success: false,
				error: error.message || 'Internal Server Error',
				stack: error.stack // Remove this in production if you don't want to expose stack traces
			}, { 
				status: 500,
				headers: corsHeaders
			});
		}
	},
};
