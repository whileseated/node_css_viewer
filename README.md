# CSV Viewer

This is a simple web application that allows users to upload and view CSV files in a tabular format. The application provides options to manipulate the view, such as showing/hiding specific columns and filtering rows.

## Features

- Upload and display CSV files in a table format
- Option to set the first row as the header or define custom headers
- Toggle visibility of the "Rank" and "Check" columns
- Show only rows with checked checkboxes
- Drag-and-drop to reorder rows
- Sorting functionality on table headers

## Project Structure

- **index.html**: The main HTML file that contains the front-end UI for the CSV uploader and viewer.
- **styles.css**: The CSS file that styles the front-end UI.
- **server.js**: The back-end server implemented with Express.js to handle file uploads and CSV parsing.
- **package.json**: The project manifest file that lists the project dependencies.

## Technologies Used

- **Front-End**:
  - HTML5
  - CSS3 (with external Bootstrap and Google Fonts integration)
  - JavaScript
  - [PapaParse](https://www.papaparse.com/) for CSV parsing in the browser

- **Back-End**:
  - Node.js
  - Express.js
  - [Multer](https://www.npmjs.com/package/multer) for handling file uploads
  - [fast-csv](https://c2fo.github.io/fast-csv/) for CSV parsing on the server

## Installation

1. Clone the repository:

   ```bash
   git clone https://github.com/your-username/csv-viewer.git
   cd csv-viewer
   ```

2. Install dependencies:

   ```bash
   npm install
   ```

## Usage

1. Start the server:

   ```bash
   node server.js
   ```

2. Open your browser and go to `http://localhost:3000`.

3. Upload a CSV file using the file input on the page. The contents of the CSV file will be displayed in a table.

## File Upload and Processing

- The server accepts a CSV file through a POST request to the `/upload` endpoint. 
- The uploaded file is processed using `fast-csv` to parse the CSV contents.
- The processed data is then sent back as a JSON response to be rendered on the client side.

## Error Handling

- The server is configured to handle uncaught exceptions and unhandled promise rejections gracefully.
- Client-side error handling is implemented during CSV parsing to alert users in case of issues.

## License

This project is licensed under the ISC License.
