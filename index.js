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

async function updateTfrJson(newTfrs, env) {
	let existingTfrs = [];
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
			mergedTfrs.push(newTfr);
		} else {
			mergedTfrs[existingIndex] = newTfr;
		}
	}

	try {
		await env.TFR_STORAGE.put('tfrs', JSON.stringify(mergedTfrs));
		console.log('Stored in KV:', mergedTfrs.length, 'TFRs');
	} catch (error) {
		console.error('Error writing to KV:', error);
	}
	return mergedTfrs;
}

export default {
	/**
	 * @param {Request} request
	 * @param {Env} env
	 * @param {ExecutionContext} ctx
	 * @returns {Promise<Response>}
	 */
	async fetch(request, env, ctx) {
		try {
			// Check if we want stored TFRs only
			if (request.url.endsWith('/stored')) {
				const stored = await env.TFR_STORAGE.get('tfrs', { type: 'json' });
				return Response.json({
					success: true,
					data: stored || []
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
				const detailResponse = await fetch(url);
				const detailHtml = await detailResponse.text();

				const coordParser = new CoordinatesParser();
				const detailRewriter = new HTMLRewriter()
					.on('font', coordParser);

				await detailRewriter.transform(new Response(detailHtml)).text();
				urlMap.set(url, coordParser.coordinates);
			});

			await Promise.all(fetchPromises);

			tableParser.tfrs.forEach(tfr => {
				if (tfr.url) {
					tfr.coordinates = urlMap.get(tfr.url) || [];
				}
			});

			const updatedTfrs = await updateTfrJson(tableParser.tfrs, env);
			
			// Set CORS headers to allow access from any origin
			const headers = new Headers({
				'Access-Control-Allow-Origin': '*',
				'Content-Type': 'application/json'
			});

			return Response.json({
				success: true,
				data: updatedTfrs
			}, { headers });

		} catch (error) {
			return Response.json({
				success: false,
				error: error.message
			}, { 
				status: 500,
				headers: {
					'Access-Control-Allow-Origin': '*',
					'Content-Type': 'application/json'
				}
			});
		}
	},
};
