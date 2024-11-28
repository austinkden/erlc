// Selectors
const newUnitBtn = document.getElementById('new-unit-btn');
const helpBtn = document.getElementById('help-btn');
const sections = {
  in: document.getElementById('in'),
  out: document.getElementById('out'),
  enroute: document.getElementById('enroute'),
  onscene: document.getElementById('onscene'),
  transport: document.getElementById('transport')
};

// Timer variable to track double-clicks for right-click
let lastRightClickTime = 0;
const doubleClickThreshold = 300; // Time in milliseconds to detect double-click (adjustable)

// Helper to create a new unit
function createUnit(unitName) {
  const unitDiv = document.createElement('div');
  unitDiv.className = 'unit';

  // Unit name (editable)
  const unitNameEl = document.createElement('p');
  unitNameEl.className = 'unit-name';
  unitNameEl.textContent = unitName || 'New Unit';

  // Enable editing of unit name on click
  unitNameEl.addEventListener('click', () => makeUnitNameEditable(unitNameEl));

  // Vehicle select
  const vehicleSelect = document.createElement('select');
  vehicleSelect.className = 'vehicle';
  const vehicleTypes = ['AMBLC', 'BATLN', 'BRUSH', 'ENGNE', 'HVRSC', 'LADDR', 'MDBUS', 'MOCMD', 'PMSUV', 'SPOPS', 'SQUAD', 'TANKR', 'UTLTY'];
  vehicleTypes.forEach(type => {
    const option = document.createElement('option');
    option.value = type.toLowerCase();
    option.textContent = type;
    vehicleSelect.appendChild(option);
  });

  // Status select
  const statusSelect = document.createElement('select');
  statusSelect.className = 'status';
  const statuses = ['INQRT', 'INSVC', 'ENRTE', 'ONSCN', 'TSPRT', 'ARRVD', 'OTSVC'];
  statuses.forEach(status => {
    const option = document.createElement('option');
    option.value = status.toLowerCase();
    option.textContent = status;
    statusSelect.appendChild(option);
  });

  // Move unit based on status change
  statusSelect.addEventListener('change', () => {
    moveUnit(unitDiv, statusSelect.value);
  });

  // Append elements to unitDiv
  unitDiv.appendChild(unitNameEl);
  unitDiv.appendChild(vehicleSelect);
  unitDiv.appendChild(statusSelect);

  // Set up the right-click listener for deleting
  setupRightClickListener(unitDiv);

  return unitDiv;
}

// Make unit name editable
function makeUnitNameEditable(unitNameEl) {
  const currentName = unitNameEl.textContent;

  // Create input field
  const input = document.createElement('input');
  input.type = 'text';
  input.value = currentName;
  input.className = 'unit-name-edit'; // Class for styling

  // Replace name element with input field
  unitNameEl.replaceWith(input);
  input.focus();

  // Save changes on Enter key press or blur
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      saveUnitName(input);
    }
  });

  input.addEventListener('blur', () => saveUnitName(input));
}

// Save the new unit name
function saveUnitName(input) {
  const newName = input.value.trim() || 'Unnamed Unit'; // Fallback if input is empty

  // Create new text element
  const unitNameEl = document.createElement('p');
  unitNameEl.className = 'unit-name';
  unitNameEl.textContent = newName;

  // Reattach the click event for editing
  unitNameEl.addEventListener('click', () => makeUnitNameEditable(unitNameEl));

  // Replace input field with the updated text element
  input.replaceWith(unitNameEl);
}

// Move unit to the correct section based on status
function moveUnit(unitDiv, status) {
  switch (status) {
    case 'inqrt':
      sections.in.appendChild(unitDiv);
      break;
    case 'insvc':  // 'INSVC' now goes to the 'in' div
      sections.in.appendChild(unitDiv);
      break;
    case 'enrte':
      sections.enroute.appendChild(unitDiv);
      break;
    case 'onscn':
      sections.onscene.appendChild(unitDiv);
      break;
    case 'tsprt':
    case 'arrvd':
      sections.transport.appendChild(unitDiv);
      break;
    case 'otsvc':
      sections.out.appendChild(unitDiv);
      break;
    default:
      console.error('Unknown status:', status);
  }
}

// Add new unit on button click
newUnitBtn.addEventListener('click', () => {
  const newUnit = createUnit(`Unit-${Math.floor(Math.random() * 100)}`);
  sections.in.appendChild(newUnit);
});

helpBtn.addEventListener('click', () => {
    window.open('https://austinkden.github.io/erlc/dispatch/fire/help.md');
});


// Listen for Alt + N key press to create a new unit
document.addEventListener('keydown', (e) => {
  if (e.altKey && e.key === 'n') {
    const newUnit = createUnit(`Unit-${Math.floor(Math.random() * 100)}`);
    sections.in.appendChild(newUnit);
  }
});

// Right-click to delete unit on double-click
function setupRightClickListener(unitDiv) {
  unitDiv.addEventListener('contextmenu', (e) => {
    e.preventDefault();  // Prevent the default context menu

    const currentTime = new Date().getTime(); // Get the current time

    if (currentTime - lastRightClickTime < doubleClickThreshold) {
      deleteUnit(unitDiv); // Delete the unit if the double-click threshold is reached
    }

    lastRightClickTime = currentTime; // Update the last right-click time
  });
}

// Delete unit
function deleteUnit(unitDiv) {
  unitDiv.remove();  // Remove the unit element from the DOM
}
