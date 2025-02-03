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
		this.debug = [];
		this.isSpaceOperation = false;  // New flag to track if current row is a space operation
		this.currentUrl = '';  // Store the current TFR URL
	}

	element(element) {
		if (element.tagName === 'tr') {
			const bgColor = element.getAttribute('bgcolor');
			this.debug.push(`TR: bgcolor=${bgColor}`);
			
			if (bgColor === 'ffffff' || bgColor === 'e7ffff') {
				this.inDataRow = true;
				this.currentRow = {};
				this.columnIndex = 0;
				this.isSpaceOperation = false;  // Reset flag for new row
				this.currentUrl = '';  // Reset URL for new row
				this.debug.push('Starting new data row');
			} else {
				this.inDataRow = false;
			}
		}

		if (element.tagName === 'a' && this.inDataRow && this.columnIndex < 6) {
			// Extract URL from anchor tag if it's the NOTAM column
			if (this.columnIndex === 1) {
				this.currentUrl = new URL(element.getAttribute('href'), 'https://tfr.faa.gov').href;
			}

			this.debug.push(`Processing anchor in column ${this.columnIndex}`);
			
			this.currentText = '';
			
			element.onEndTag(() => {
				const content = this.currentText.trim();
				this.debug.push(`Anchor content: "${content}"`);
				
				if (content) {
					let cleanContent;
					
					if (this.columnIndex === 0) {  // Date column
						const dateMatch = content.match(/\d{2}\/\d{2}\/\d{4}/) || 
										 content.match(/\d{2}\/\d{2}\/\d{2}/) ||
										 content.match(/\d{1,2}\/\d{1,2}\/\d{4}/);
						cleanContent = dateMatch ? dateMatch[0] : content.trim();
					} else if (this.columnIndex === 5) {  // Description column
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
						
						// Check if this is a space operation when we hit the type column
						if (this.columnIndex === 4 && cleanContent === 'SPACE OPERATIONS') {
							this.isSpaceOperation = true;
						}
					}
					
					this.currentRow[this.columns[this.columnIndex]] = cleanContent;
					this.columnIndex++;
					
					if (this.columnIndex === 6 && this.isSpaceOperation) {
						this.currentRow.url = this.currentUrl;  // Add URL to the row data
						this.tfrs.push({...this.currentRow});
						this.debug.push('Row complete, added space operation to tfrs');
					}
				}
			});
		}
	}

	text(text) {
		if (this.inDataRow && this.columnIndex < 6) {
			this.currentText += text.text;
			this.debug.push(`Text added: "${text.text.trim()}"`);
		}
	}
}

// New class to parse coordinates from TFR detail pages
class CoordinatesParser {
	constructor() {
		this.coordinates = [];
		this.currentRow = [];
		this.debug = [];
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
					.replace(/&#xBA;/g, '°')  // Convert degree symbol
					.replace(/&#x2019;/g, "'"); // Convert quotes
				
				if (content.includes('°')) {
					this.currentRow.push(content);
					this.debug.push(`Found coordinate: ${content}`);
					
					if (this.currentRow.length === 2) {
						this.coordinates.push({
							lat: this.currentRow[0],
							long: this.currentRow[1]
						});
						this.currentRow = [];
						this.debug.push('Added coordinate pair');
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

export default {
	/**
	 * @param {Request} request
	 * @param {Env} env
	 * @param {ExecutionContext} ctx
	 * @returns {Promise<Response>}
	 */
	async fetch(request, env, ctx) {
		try {
			// Fetch and parse the main TFR list
			const response = await fetch("https://tfr.faa.gov/tfr2/list.html");
			const html = await response.text();

			const tableParser = new TableParser();
			const rewriter = new HTMLRewriter()
				.on('tr', tableParser)
				.on('td', tableParser)
				.on('a', tableParser);

			await rewriter.transform(new Response(html)).text();

			// Create a map to store unique URLs and their parsed coordinates
			const urlMap = new Map();
			const parsingLogs = [];  // Collect debug logs from all parsers
			
			// Collect unique URLs
			tableParser.tfrs.forEach(tfr => {
				if (tfr.url && !urlMap.has(tfr.url)) {
					urlMap.set(tfr.url, null);
				}
			});

			// Fetch and parse coordinates for unique URLs
			const fetchPromises = Array.from(urlMap.keys()).map(async url => {
				const detailResponse = await fetch(url);
				const detailHtml = await detailResponse.text();

				const coordParser = new CoordinatesParser();
				coordParser.debug.push(`Processing URL: ${url}`);

				const detailRewriter = new HTMLRewriter()
					.on('font', coordParser);

				await detailRewriter.transform(new Response(detailHtml)).text();
				coordParser.debug.push(`Found ${coordParser.coordinates.length} coordinate pairs`);
				urlMap.set(url, coordParser.coordinates);
				parsingLogs.push(...coordParser.debug);  // Collect debug logs
			});

			// Wait for all fetches to complete
			await Promise.all(fetchPromises);

			// Add coordinates to TFRs
			tableParser.tfrs.forEach(tfr => {
				if (tfr.url) {
					tfr.coordinates = urlMap.get(tfr.url) || [];
				}
			});

			return Response.json({
				success: true,
				data: tableParser.tfrs,
				debug: {
					totalRows: tableParser.tfrs.length,
					uniqueTypes: [...new Set(tableParser.tfrs.map(tfr => tfr.type))],
					firstFewRows: tableParser.tfrs.slice(0, 3),
					parsingLog: tableParser.debug.slice(0, 50),
					coordinateParsingLog: parsingLogs  // Use collected logs
				}
			});

		} catch (error) {
			return Response.json({
				success: false,
				error: error.message,
				stack: error.stack
			}, { status: 500 });
		}
	},
};
